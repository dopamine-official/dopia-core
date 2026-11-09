package com.dopia.account

import com.dopia.chat.ChatService
import com.dopia.common.ApiException
import com.dopia.common.AppEvents
import com.dopia.common.ConsentItem
import com.dopia.common.Cookies
import com.dopia.common.FieldError
import com.dopia.common.Identity
import com.dopia.common.RegionConfig
import com.dopia.common.Tokens
import com.dopia.config.AppProperties
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.springframework.context.annotation.Lazy
import org.springframework.dao.DuplicateKeyException
import org.springframework.http.HttpStatus
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.format.DateTimeParseException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class AccountView(
    val accountId: UUID,
    val isGuest: Boolean,
    val nickname: String?,
    val photoUrl: String?,
    val adultMode: Boolean,
    val adultVerified: Boolean,
    val adultVerificationRejected: Boolean,
    val consentRequired: Boolean,
    // The request region's consent items; the web shows these, not a copy of its own.
    val consentItems: List<ConsentItem>,
)

data class IssuedAccount(
    val accountId: UUID,
)

fun AccountRow.view(
    consentRequired: Boolean,
    consentItems: List<ConsentItem>,
) = AccountView(
    accountId = id,
    isGuest = isGuest,
    nickname = if (isGuest) null else nickname,
    photoUrl = photoUrl,
    adultMode = !isGuest && adultMode,
    adultVerified = !isGuest && adultVerifiedAt != null,
    adultVerificationRejected = !isGuest && birthDate != null && adultVerifiedAt == null,
    consentRequired = consentRequired,
    consentItems = consentItems,
)

@Service
class AccountService(
    private val accounts: AccountRepository,
    private val cookies: Cookies,
    private val tx: TransactionTemplate,
    private val properties: AppProperties,
    private val storage: PhotoStorage,
    private val events: AppEvents,
    @Lazy private val chat: ChatService,
) {
    private val log = LoggerFactory.getLogger(AccountService::class.java)
    private val headerAccount = "X-Preview-Account"

    // Merge attempts per guest for `attempt` (TRACKING-PLAN 8-1-5, 8-1-6). Kept in memory: a
    // restart counts again from 1. How to keep it across restarts is open (TBD 3 ACCOUNT).
    private val mergeAttempts = ConcurrentHashMap<UUID, Int>()

    // 4-1-2 request identification

    fun identifyOrNull(request: HttpServletRequest): AccountRow? {
        cookies.read(request, Cookies.SESSION)?.let { token ->
            accounts.findBySession(Tokens.sha256(token))?.let { return it }
        }
        cookies.read(request, Cookies.GUEST)?.let { token ->
            val guest = accounts.findByGuestToken(Tokens.sha256(token)) ?: return null
            if (guest.mergeTargetAccountId != null) return null
            accounts.touchGuest(guest.id)
            return guest
        }
        return null
    }

    fun identify(request: HttpServletRequest): Identity {
        val row = identifyOrNull(request) ?: throw ApiException.unauthorized()
        // The web pins requests to the account it rendered; a different cookie owner is a changed session.
        request.getHeader(headerAccount)?.takeIf { it.isNotBlank() }?.let { expected ->
            if (expected != row.id.toString()) {
                throw ApiException("account_changed", HttpStatus.UNAUTHORIZED, message = "cookie belongs to another account")
            }
        }
        return Identity(row.id, row.isGuest, !row.isGuest && row.adultMode)
    }

    /** Guest write check (4-2-7): inside the caller's transaction, the guest must still be active. */
    fun assertGuestWritable(identity: Identity) {
        if (identity.isMember) return
        val row = accounts.lock(identity.accountId) ?: throw ApiException.unauthorized()
        if (row.deletedAt != null || row.mergeTargetAccountId != null) throw ApiException.unauthorized()
    }

    // 4-1-1 guest issuance

    fun issueGuest(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): IssuedAccount {
        identifyOrNull(request)?.let { return IssuedAccount(it.id) }
        // A guest cookie whose guest already went to a member cannot be used again.
        val merged =
            cookies
                .read(request, Cookies.GUEST)
                ?.let { accounts.findByGuestToken(Tokens.sha256(it)) }
                ?.mergeTargetAccountId != null
        return IssuedAccount(createGuest(response, if (merged) "merged_guest_blocked" else "first_visit"))
    }

    /** [reason] for `server_guest_created`: first_visit, logout, withdraw or merged_guest_blocked. */
    fun createGuest(
        response: HttpServletResponse,
        reason: String = "first_visit",
    ): UUID {
        val token = Tokens.random()
        val id = tx.execute { accounts.insertGuest(Tokens.sha256(token)) }!!
        cookies.setGuest(response, token)
        events.record(id, "server_guest_created", mapOf("reason" to reason))
        return id
    }

    fun me(
        identity: Identity,
        region: RegionConfig,
    ): AccountView {
        val row = accounts.find(identity.accountId) ?: throw ApiException.unauthorized()
        return row.view(consentRequired(identity.accountId, region), region.consentItems)
    }

    // 4-1-9 consents

    /** True when a required item of the region lacks a record for its current version. */
    private fun consentRequired(
        accountId: UUID,
        region: RegionConfig,
    ): Boolean {
        val required = region.consentItems.filter { it.required }
        if (required.isEmpty()) return false
        val agreed = accounts.consents(accountId)
        return required.any { (it.id to it.version) !in agreed }
    }

    /** Chat waits until the required consents are given (4-1-9). */
    fun assertConsented(
        identity: Identity,
        region: RegionConfig,
    ) {
        if (consentRequired(identity.accountId, region)) {
            throw ApiException("consent_required", HttpStatus.FORBIDDEN, message = "required consents are not given")
        }
    }

    fun recordConsents(
        identity: Identity,
        items: List<Pair<String, String>>,
        region: RegionConfig,
    ): AccountView {
        val current = region.consentItems.associateBy { it.id }
        val unknown = items.filter { (id, version) -> current[id]?.version != version }
        if (items.isEmpty() || unknown.isNotEmpty()) {
            throw ApiException.invalidInput(FieldError("items", "unknown_item_or_version"))
        }
        val given = items.map { it.first }.toSet()
        if (region.consentItems.any { it.required && it.id !in given }) {
            throw ApiException.invalidInput(FieldError("items", "required_missing"))
        }
        tx.execute {
            // A guest already merged or leaving would keep consents its member never gets.
            assertGuestWritable(identity)
            items.distinct().forEach { (id, version) -> accounts.insertConsent(identity.accountId, id, version) }
        }
        return me(identity, region)
    }

    // 4-1-8 adult verification

    fun verifyAdult(
        identity: Identity,
        gender: String?,
        birthDate: String?,
        region: RegionConfig,
    ): AccountView {
        if (identity.isGuest) throw ApiException("member_required", HttpStatus.FORBIDDEN, message = "guests cannot verify age")
        if (!region.adultModeAvailable) {
            throw ApiException("adult_mode_unavailable", HttpStatus.FORBIDDEN, message = "region does not offer adult mode")
        }
        val adultAge = region.adultAge
        val zone = region.timeZone
        if (region.verificationMethod != BIRTH_DATE_ONLY || adultAge == null || zone == null) {
            throw ApiException(
                "adult_verification_unavailable",
                HttpStatus.FORBIDDEN,
                message = "region does not accept birth date verification",
            )
        }
        val errors = mutableListOf<FieldError>()
        if (gender !in GENDERS) errors += FieldError("gender", "invalid")
        val today = LocalDate.now(zone)
        val birth =
            try {
                birthDate?.let { LocalDate.parse(it) }
            } catch (error: DateTimeParseException) {
                null
            }
        if (birth == null || birth.isBefore(EARLIEST_BIRTH_DATE) || birth.isAfter(today)) errors += FieldError("birth_date", "invalid")
        if (errors.isNotEmpty()) throw ApiException.invalidInput(*errors.toTypedArray())
        val verified = Period.between(birth!!, today).years >= adultAge
        val stored = tx.execute { accounts.submitAdultVerification(identity.accountId, gender!!, birth, verified) }!!
        if (!stored) {
            throw ApiException(
                "adult_verification_submitted",
                HttpStatus.CONFLICT,
                message = "adult verification was already submitted",
            )
        }
        return me(identity, region)
    }

    // 4-1-6 profile

    fun updateProfile(
        identity: Identity,
        nickname: String?,
        photo: ByteArray?,
        region: RegionConfig,
    ): AccountView {
        if (identity.isGuest) throw ApiException("member_required", HttpStatus.FORBIDDEN, message = "guests have no profile")
        if (nickname == null && photo == null) throw ApiException.invalidInput()
        val cleaned = nickname?.filterNot { it.isISOControl() }?.trim()
        if (cleaned != null && cleaned.isEmpty()) throw ApiException.invalidInput(FieldError("nickname", "required"))
        if (cleaned != null && accounts.nicknameTaken(cleaned, identity.accountId)) {
            throw ApiException("nickname_taken", HttpStatus.CONFLICT, listOf(FieldError("nickname", "taken")), "nickname already in use")
        }
        var photoUrl: String? = null
        if (photo != null) {
            val type =
                detectImageType(photo)
                    ?: throw ApiException(
                        "photo_type_invalid",
                        HttpStatus.UNPROCESSABLE_CONTENT,
                        listOf(FieldError("photo", "invalid_type")),
                        "unsupported image format",
                    )
            if (photo.size > properties.photo.maxBytes) {
                throw ApiException(
                    "file_too_large",
                    HttpStatus.PAYLOAD_TOO_LARGE,
                    listOf(FieldError("photo", "too_large")),
                    "photo exceeds the size limit",
                )
            }
            photoUrl = storage.store(identity.accountId, photo, type)
        }
        val previous = accounts.find(identity.accountId)?.photoUrl
        try {
            tx.execute { accounts.updateProfile(identity.accountId, cleaned, photoUrl) }
        } catch (error: DuplicateKeyException) {
            photoUrl?.let(storage::delete)
            throw ApiException("nickname_taken", HttpStatus.CONFLICT, listOf(FieldError("nickname", "taken")), "nickname already in use")
        }
        if (photoUrl != null && previous != null) storage.delete(previous)
        val changed =
            when {
                cleaned != null && photoUrl != null -> "both"
                photoUrl != null -> "photo"
                else -> "nickname"
            }
        events.record(identity.accountId, "server_profile_updated", mapOf("changed" to changed))
        return me(identity, region)
    }

    // 4-1-7 adult mode

    fun updateAdultMode(
        identity: Identity,
        adultMode: Boolean,
        region: RegionConfig,
    ): AccountView {
        if (identity.isGuest) {
            val code = if (adultMode) "adult_verification_required" else "member_required"
            throw ApiException(code, HttpStatus.FORBIDDEN, message = "guests cannot change adult mode")
        }
        if (adultMode) {
            if (!region.adultModeAvailable) {
                throw ApiException(
                    "adult_mode_unavailable",
                    HttpStatus.FORBIDDEN,
                    message = "region does not offer adult mode",
                )
            }
            val row = accounts.find(identity.accountId) ?: throw ApiException.unauthorized()
            if (row.adultVerifiedAt ==
                null
            ) {
                throw ApiException("adult_verification_required", HttpStatus.FORBIDDEN, message = "adult verification incomplete")
            }
        }
        val changed = tx.execute { accounts.updateAdultMode(identity.accountId, adultMode) }!!
        // A request for the value already set (a second, stale tab) changes nothing to record.
        if (changed) events.record(identity.accountId, "server_safe_mode_changed", mapOf("adult_mode" to adultMode))
        return me(identity, region)
    }

    // 4-1-10 logout and withdrawal

    fun logout(
        identity: Identity,
        request: HttpServletRequest,
        response: HttpServletResponse,
        withdraw: Boolean,
    ): IssuedAccount {
        if (identity.isGuest) throw ApiException("member_required", HttpStatus.FORBIDDEN, message = "guests cannot log out")
        val sessionToken = cookies.read(request, Cookies.SESSION)
        val createdAt = if (withdraw) accounts.createdAt(identity.accountId) else null
        val guestToken = Tokens.random()
        val guestId =
            tx.execute {
                if (withdraw) {
                    accounts.revokeAllSessions(identity.accountId)
                    accounts.markDeleted(identity.accountId)
                } else if (sessionToken != null) {
                    accounts.revokeSession(Tokens.sha256(sessionToken))
                }
                val guestId = accounts.insertGuest(Tokens.sha256(guestToken))
                // The next person on this browser agrees for themselves (4-1-10): no consent copy.
                guestId
            }!!
        cookies.clearSession(response)
        cookies.setGuest(response, guestToken)
        if (withdraw) {
            val days = createdAt?.let { Duration.between(it, Instant.now()).toDays() } ?: 0
            events.record(identity.accountId, "server_withdrawn", mapOf("days_since_created" to days))
        } else {
            events.record(identity.accountId, "server_logged_out")
        }
        events.record(guestId, "server_guest_created", mapOf("reason" to if (withdraw) "withdraw" else "logout"))
        return IssuedAccount(guestId)
    }

    // 4-1-4 login completion (provider callback or dev mock login)

    data class ProviderProfile(
        val provider: String,
        val subject: String,
        val name: String?,
        val email: String?,
    )

    /** Transaction 1 of login: member lookup or creation, session, merge target. Returns the session token. */
    fun completeLogin(
        profile: ProviderProfile,
        guestAccountId: UUID?,
        response: HttpServletResponse,
    ): UUID {
        val token = Tokens.random()
        var isNewMember = false
        var hadGuest = false
        var mergeScheduled = false
        val memberId =
            tx.execute {
                isNewMember = false
                hadGuest = false
                mergeScheduled = false
                val existing =
                    accounts
                        .findIdentityAccount(profile.provider, profile.subject)
                        ?.let { accounts.find(it) }
                        ?.takeIf { it.deletedAt == null }
                val memberId =
                    existing?.id ?: run {
                        isNewMember = true
                        val id = accounts.insertMember(uniqueNickname(profile.name ?: DEFAULT_NAME), profile.email)
                        accounts.upsertIdentity(profile.provider, profile.subject, id)
                        id
                    }
                accounts.insertSession(memberId, Tokens.sha256(token), properties.session.ttl.seconds)
                accounts.touchLogin(memberId)
                if (guestAccountId != null) {
                    val guest = accounts.lock(guestAccountId)
                    if (guest != null && guest.isGuest && guest.deletedAt == null) {
                        hadGuest = true
                        accounts.copyConsents(guestAccountId, memberId)
                        when (guest.mergeTargetAccountId) {
                            null -> {
                                accounts.setMergeTarget(guestAccountId, memberId)
                                mergeScheduled = true
                            }

                            memberId -> {
                                mergeScheduled = true
                            }

                            else -> {
                                throw ApiException(
                                    "login_failed",
                                    HttpStatus.CONFLICT,
                                    message = "guest already merging into another member",
                                )
                            }
                        }
                    }
                }
                memberId
            }!!
        cookies.setSession(response, token)
        events.record(
            memberId,
            "server_login_succeeded",
            mapOf(
                "provider" to profile.provider,
                "is_new_member" to isNewMember,
                "had_guest" to hadGuest,
                "merge_scheduled" to mergeScheduled,
            ),
        )
        if (guestAccountId != null) {
            events.alias(guestAccountId, memberId)
            runCatching { merge(guestAccountId) }.onFailure { log.warn("merge of guest {} failed; will retry", guestAccountId, it) }
        }
        return memberId
    }

    private fun uniqueNickname(base: String): String {
        var candidate = base.filterNot { it.isISOControl() }.trim().ifEmpty { "Explorer" }
        while (accounts.nicknameTaken(candidate, null)) candidate += " ✦"
        return candidate
    }

    /** Transaction 2 of login (4-1-5): mark merged and move the guest's data into the member. */
    fun merge(guestAccountId: UUID) {
        val target = accounts.find(guestAccountId)?.takeIf { it.mergedIntoAccountId == null }?.mergeTargetAccountId ?: return
        val attempt = mergeAttempts.merge(guestAccountId, 1, Int::plus)!!
        val moved =
            try {
                tx.execute {
                    val guest = accounts.lock(guestAccountId) ?: return@execute null
                    val lockedTarget = guest.mergeTargetAccountId ?: return@execute null
                    if (guest.mergedIntoAccountId != null) return@execute null
                    accounts.markMerged(guestAccountId, lockedTarget)
                    lockedTarget to chat.transferOwner(guestAccountId, lockedTarget)
                }
            } catch (error: Exception) {
                events.record(
                    target,
                    "server_merge_failed",
                    mapOf(
                        "guest_account_id" to guestAccountId.toString(),
                        "attempt" to attempt,
                        "error" to error.javaClass.simpleName,
                    ),
                )
                throw error
            }
        mergeAttempts.remove(guestAccountId)
        if (moved == null) return
        events.record(
            moved.first,
            "server_merge_completed",
            mapOf("guest_account_id" to guestAccountId.toString(), "room_count" to moved.second, "attempt" to attempt),
        )
    }

    @Scheduled(initialDelayString = "PT5S", fixedDelayString = "PT60S")
    fun retryPendingMerges() {
        for (id in accounts.pendingMerges()) {
            runCatching { merge(id) }.onFailure { log.warn("merge retry of guest {} failed", id, it) }
        }
    }

    @Scheduled(initialDelayString = "PT1M", fixedDelayString = "PT1H")
    fun cleanSessions() {
        runCatching { accounts.deleteDeadSessions() }.onFailure { log.warn("session cleanup failed", it) }
    }

    companion object {
        const val BIRTH_DATE_ONLY = "birth_date_only"
        const val DEFAULT_NAME = "Google Explorer"
        val GENDERS = setOf("male", "female")
        val EARLIEST_BIRTH_DATE: LocalDate = LocalDate.of(1900, 1, 1)
    }
}

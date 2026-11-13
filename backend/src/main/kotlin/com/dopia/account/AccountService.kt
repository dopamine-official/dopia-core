package com.dopia.account

import com.dopia.common.ApiException
import com.dopia.common.AppEvents
import com.dopia.common.ConsentItem
import com.dopia.common.Cookies
import com.dopia.common.FieldError
import com.dopia.common.I18n
import com.dopia.common.Identity
import com.dopia.common.RegionConfig
import com.dopia.common.Tokens
import com.dopia.config.AppProperties
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
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
    private val i18n: I18n,
    private val characters: com.dopia.character.CharacterRepository,
) {
    private val log = LoggerFactory.getLogger(AccountService::class.java)
    private val headerAccount = "X-Preview-Account"

    // 4-1-2 request identification

    fun identifyOrNull(request: HttpServletRequest): AccountRow? {
        cookies.read(request, Cookies.SESSION)?.let { token ->
            accounts.findBySession(Tokens.sha256(token))?.let { return it }
        }
        cookies.read(request, Cookies.GUEST)?.let { token ->
            val guest = accounts.findByGuestToken(Tokens.sha256(token)) ?: return null
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
        return Identity(row.id, row.isGuest, !row.isGuest && row.adultMode, !row.isGuest && row.adultVerifiedAt != null)
    }

    /** Chat is for members only (CHAT 4-1-1, 4-1-3): a guest is sent to the login modal. */
    fun assertMember(identity: Identity) {
        if (identity.isGuest) throw ApiException("member_required", HttpStatus.FORBIDDEN, message = "chat is for members only")
    }

    // 4-1-1 guest issuance

    fun issueGuest(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): IssuedAccount {
        identifyOrNull(request)?.let { return IssuedAccount(it.id) }
        return IssuedAccount(createGuest(response, "first_visit"))
    }

    /** [reason] for `server_guest_created`: first_visit, logout or withdraw. */
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

    // 4-1-8 consents

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

    /** Chat waits until the required consents are given (4-1-8). */
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
        val recorded =
            tx.execute {
                // Serialized with the login copying this guest's consents: none is left behind.
                if (identity.isGuest) accounts.lock(identity.accountId)
                items.distinct().filter { (id, version) -> accounts.insertConsent(identity.accountId, id, version) }.map { it.first }
            }!!
        // Agreeing again to what is already recorded is no new consent (TRACKING-PLAN 8-1-9).
        if (recorded.isNotEmpty()) {
            events.record(
                identity.accountId,
                "server_consents_recorded",
                mapOf("items" to recorded, "is_guest" to identity.isGuest),
                consentPerson(identity.accountId),
            )
        }
        return me(identity, region)
    }

    // 4-1-7 adult verification

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
        val age = Period.between(birth!!, today).years
        val verified = age >= adultAge
        val stored = tx.execute { accounts.submitAdultVerification(identity.accountId, gender!!, birth, verified) }!!
        if (!stored) {
            throw ApiException(
                "adult_verification_submitted",
                HttpStatus.CONFLICT,
                message = "adult verification was already submitted",
            )
        }
        events.record(
            identity.accountId,
            "server_adult_verification_submitted",
            mapOf("result" to if (verified) "passed" else "rejected", "gender" to gender, "age" to age),
            // From this submission itself, the same age as the event: no read a parallel request could outrun.
            verificationPerson(verified, gender!!, age),
        )
        // Passing turns adult mode on in the same update (TRACKING-PLAN 8-1-8).
        if (verified) events.record(identity.accountId, "server_safe_mode_changed", mapOf("adult_mode" to true))
        return me(identity, region)
    }

    // 4-1-5 profile

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

    // 4-1-6 adult mode

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

    // 4-1-9 logout and withdrawal

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
                    // CHARACTER 4-1-6: in the same transaction, so a failure keeps the account.
                    characters.softDeleteByCreator(identity.accountId)
                } else if (sessionToken != null) {
                    accounts.revokeSession(Tokens.sha256(sessionToken))
                }
                val guestId = accounts.insertGuest(Tokens.sha256(guestToken))
                // The next person on this browser agrees for themselves (4-1-9): no consent copy.
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

    /** The login transaction (4-1-4): member lookup or creation, session, the guest's consents. */
    fun completeLogin(
        profile: ProviderProfile,
        guestAccountId: UUID?,
        response: HttpServletResponse,
    ): UUID {
        val token = Tokens.random()
        var isNewMember = false
        var hadGuest = false
        val memberId =
            tx.execute {
                isNewMember = false
                hadGuest = false
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
                        // The guest ends here: once the session is gone this browser gets a new
                        // guest, never this one, so two people on one browser stay apart.
                        accounts.deleteGuestIdentifier(guestAccountId)
                    }
                }
                memberId
            }!!
        cookies.setSession(response, token)
        if (guestAccountId != null) cookies.clearGuest(response)
        events.record(
            memberId,
            "server_login_succeeded",
            mapOf(
                "provider" to profile.provider,
                "is_new_member" to isNewMember,
                "had_guest" to hadGuest,
            ),
            // The browser redirect carries no region: the deployment's default one.
            loginPerson(memberId, i18n.region(null)),
        )
        if (guestAccountId != null) events.alias(guestAccountId, memberId)
        return memberId
    }

    // PostHog person properties (TRACKING-PLAN 8-4). Each event sets only what it changed, so a
    // late snapshot from a parallel request cannot undo another one. Never the birth date.

    /** The latest agreed version of each item. */
    private fun consentPerson(accountId: UUID): Map<String, Any> =
        accounts.agreedVersions(accountId).entries.associate { (id, version) -> "consent_${id}_version" to version }

    private fun verificationPerson(
        passed: Boolean,
        gender: String,
        age: Int?,
    ): Map<String, Any> =
        buildMap {
            put("adult_verification_result", if (passed) "passed" else "rejected")
            put("adult_verified", passed)
            put("gender", gender)
            age?.let { put("age", it) }
        }

    /** Everything from the DB: the guest's consents were just copied, and the age moves on. */
    private fun loginPerson(
        accountId: UUID,
        region: RegionConfig,
    ): Map<String, Any> {
        val verification =
            accounts.verification(accountId)?.let { (gender, birth, passed) ->
                verificationPerson(passed, gender, region.timeZone?.let { Period.between(birth, LocalDate.now(it)).years })
            } ?: mapOf("adult_verified" to false)
        return consentPerson(accountId) + verification
    }

    private fun uniqueNickname(base: String): String {
        var candidate = base.filterNot { it.isISOControl() }.trim().ifEmpty { "Explorer" }
        while (accounts.nicknameTaken(candidate, null)) candidate += " ✦"
        return candidate
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

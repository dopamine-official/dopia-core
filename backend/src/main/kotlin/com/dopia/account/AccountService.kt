package com.dopia.account

import com.dopia.chat.ChatService
import com.dopia.common.ApiException
import com.dopia.common.AppEvents
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
import java.util.UUID

data class AccountView(
    val accountId: UUID,
    val isGuest: Boolean,
    val nickname: String?,
    val photoUrl: String?,
    val adultMode: Boolean,
    val adultVerified: Boolean,
)

data class IssuedAccount(
    val accountId: UUID,
)

fun AccountRow.view() =
    AccountView(
        accountId = id,
        isGuest = isGuest,
        nickname = if (isGuest) null else nickname,
        photoUrl = photoUrl,
        adultMode = !isGuest && adultMode,
        adultVerified = !isGuest && adultVerifiedAt != null,
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
        return IssuedAccount(createGuest(response))
    }

    fun createGuest(response: HttpServletResponse): UUID {
        val token = Tokens.random()
        val id = tx.execute { accounts.insertGuest(Tokens.sha256(token)) }!!
        cookies.setGuest(response, token)
        events.record(id, "guest_created")
        return id
    }

    fun me(identity: Identity): AccountView = accounts.find(identity.accountId)?.view() ?: throw ApiException.unauthorized()

    // 4-1-6 profile

    fun updateProfile(
        identity: Identity,
        nickname: String?,
        photo: ByteArray?,
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
        events.record(identity.accountId, "profile_updated")
        return me(identity)
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
        tx.execute { accounts.updateAdultMode(identity.accountId, adultMode) }
        events.record(identity.accountId, "safe_mode_changed", mapOf("adult_mode" to adultMode))
        return me(identity)
    }

    // 4-1-8 logout and withdrawal

    fun logout(
        identity: Identity,
        request: HttpServletRequest,
        response: HttpServletResponse,
        withdraw: Boolean,
    ): IssuedAccount {
        if (identity.isGuest) throw ApiException("member_required", HttpStatus.FORBIDDEN, message = "guests cannot log out")
        val sessionToken = cookies.read(request, Cookies.SESSION)
        val guestToken = Tokens.random()
        val guestId =
            tx.execute {
                if (withdraw) {
                    accounts.revokeAllSessions(identity.accountId)
                    accounts.markDeleted(identity.accountId)
                } else if (sessionToken != null) {
                    accounts.revokeSession(Tokens.sha256(sessionToken))
                }
                accounts.insertGuest(Tokens.sha256(guestToken))
            }!!
        cookies.clearSession(response)
        cookies.setGuest(response, guestToken)
        events.record(identity.accountId, if (withdraw) "withdrawn" else "logout_succeeded")
        events.record(guestId, "guest_created")
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
        val memberId =
            tx.execute {
                val existing =
                    accounts
                        .findIdentityAccount(profile.provider, profile.subject)
                        ?.let { accounts.find(it) }
                        ?.takeIf { it.deletedAt == null }
                val memberId =
                    existing?.id ?: run {
                        val id = accounts.insertMember(uniqueNickname(profile.name ?: defaultName(profile.provider)), profile.email)
                        accounts.upsertIdentity(profile.provider, profile.subject, id)
                        id
                    }
                accounts.insertSession(memberId, Tokens.sha256(token), properties.session.ttl.seconds)
                accounts.touchLogin(memberId)
                if (guestAccountId != null) {
                    val guest = accounts.lock(guestAccountId)
                    if (guest != null && guest.isGuest && guest.deletedAt == null) {
                        when (guest.mergeTargetAccountId) {
                            null -> accounts.setMergeTarget(guestAccountId, memberId)

                            memberId -> Unit

                            else -> throw ApiException(
                                "login_failed",
                                HttpStatus.CONFLICT,
                                message = "guest already merging into another member",
                            )
                        }
                    }
                }
                memberId
            }!!
        cookies.setSession(response, token)
        events.record(memberId, "login_succeeded", mapOf("provider" to profile.provider))
        if (guestAccountId != null) {
            events.alias(guestAccountId, memberId)
            runCatching { merge(guestAccountId) }.onFailure { log.warn("merge of guest {} failed; will retry", guestAccountId, it) }
        }
        return memberId
    }

    private fun defaultName(provider: String) = if (provider == "google") "Google Explorer" else "Apple Explorer"

    private fun uniqueNickname(base: String): String {
        var candidate = base.filterNot { it.isISOControl() }.trim().ifEmpty { "Explorer" }
        while (accounts.nicknameTaken(candidate, null)) candidate += " ✦"
        return candidate
    }

    /** Transaction 2 of login (4-1-5): mark merged and move the guest's data into the member. */
    fun merge(guestAccountId: UUID) {
        tx.execute {
            val guest = accounts.lock(guestAccountId) ?: return@execute
            val target = guest.mergeTargetAccountId ?: return@execute
            if (guest.mergedIntoAccountId != null) return@execute
            accounts.markMerged(guestAccountId, target)
            chat.transferOwner(guestAccountId, target)
        }
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
}

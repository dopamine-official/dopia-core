package com.dopia.account

import com.dopia.common.ApiException
import com.dopia.common.AppEvents
import com.dopia.common.Cookies
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** Login start and provider callbacks (ACCOUNT 4-2-3). Results travel by redirect, never JSON. */
@RestController
@RequestMapping("/api/v1/account/auth")
class AuthController(
    private val oauth: OAuthService,
    private val accounts: AccountService,
    private val cookies: Cookies,
    private val events: AppEvents,
) {
    private val log = LoggerFactory.getLogger(AuthController::class.java)

    @GetMapping("/{provider}/start")
    fun start(
        @PathVariable provider: String,
        @RequestParam("return_to", required = false) returnToParam: String?,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): ResponseEntity<Void> {
        if (!oauth.isProvider(provider)) throw ApiException("provider_not_found", HttpStatus.NOT_FOUND, message = "unknown provider")
        val returnTo = oauth.safeReturnTo(returnToParam)
        val current = accounts.identifyOrNull(request)
        if (current != null && !current.isGuest) return redirect(HttpStatus.FOUND, oauth.webUrl(returnTo))
        if (!oauth.isConfigured(provider)) {
            log.warn("{} login requested but not configured", provider)
            return redirect(HttpStatus.FOUND, oauth.loginModalUrl(returnTo, failed = true))
        }
        val state = oauth.newState(provider, returnTo, current?.id)
        cookies.setLoginState(response, oauth.sign(state), sameSiteNone = provider == "apple")
        return redirect(HttpStatus.FOUND, oauth.authorizeUrl(provider, state.state))
    }

    @GetMapping("/google/callback")
    fun googleCallback(
        @RequestParam(required = false) code: String?,
        @RequestParam(required = false) state: String?,
        @RequestParam(required = false) error: String?,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): ResponseEntity<Void> = callback("google", code, state, error, null, request, response, HttpStatus.FOUND)

    @PostMapping("/apple/callback", consumes = ["application/x-www-form-urlencoded"])
    fun appleCallback(
        @RequestParam(required = false) code: String?,
        @RequestParam(required = false) state: String?,
        @RequestParam(required = false) error: String?,
        @RequestParam(required = false) user: String?,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): ResponseEntity<Void> = callback("apple", code, state, error, user, request, response, HttpStatus.SEE_OTHER)

    private fun callback(
        provider: String,
        code: String?,
        state: String?,
        error: String?,
        user: String?,
        request: HttpServletRequest,
        response: HttpServletResponse,
        status: HttpStatus,
    ): ResponseEntity<Void> {
        cookies.clearLoginState(response, sameSiteNone = provider == "apple")
        // Recorded under the guest that started the login; with no guest there is no one to record.
        val visitor = { guest: java.util.UUID? -> guest ?: accounts.identifyOrNull(request)?.id }
        val saved =
            try {
                oauth.verify(cookies.read(request, Cookies.LOGIN_STATE), provider)
            } catch (failure: LoginFailed) {
                log.info("{} login state rejected: {}", provider, failure.message)
                visitor(null)?.let { loginFailed(it, provider, "state_mismatch") }
                return redirect(status, oauth.loginModalUrl("/", failed = true))
            }
        if (error != null) {
            visitor(saved.guestAccountId)?.let {
                events.record(it, "server_login_cancelled", mapOf("provider" to provider))
            }
            return redirect(status, oauth.loginModalUrl(saved.returnTo, failed = false))
        }
        var stage = "state_mismatch"
        try {
            if (state != saved.state) throw LoginFailed("state mismatch")
            stage = "token_invalid"
            if (code.isNullOrBlank()) throw LoginFailed("code missing")
            val profile = oauth.exchange(provider, code, user)
            stage = "transaction_failed"
            accounts.completeLogin(profile, saved.guestAccountId, response)
        } catch (failure: Exception) {
            log.warn("{} login failed: {}", provider, failure.message)
            // The guest is already going to another member (ACCOUNT 4-1-4).
            val reason = if (failure is ApiException && failure.code == "login_failed") "guest_already_pending" else stage
            visitor(saved.guestAccountId)?.let { loginFailed(it, provider, reason) }
            return redirect(status, oauth.loginModalUrl(saved.returnTo, failed = true))
        }
        return redirect(status, oauth.webUrl(saved.returnTo))
    }

    /** `server_login_failed` (TRACKING-PLAN 8-1-3). */
    private fun loginFailed(
        accountId: java.util.UUID,
        provider: String,
        reason: String,
    ) = events.record(accountId, "server_login_failed", mapOf("provider" to provider, "reason" to reason))

    private fun redirect(
        status: HttpStatus,
        location: String,
    ): ResponseEntity<Void> =
        ResponseEntity
            .status(status)
            .header(HttpHeaders.LOCATION, location)
            .header(HttpHeaders.CACHE_CONTROL, "no-store")
            .build()
}

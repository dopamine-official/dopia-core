package com.dopia.common

import com.dopia.config.AppProperties
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseCookie
import org.springframework.stereotype.Component
import java.time.Duration

/** Cookie names and attributes from ACCOUNT 4-2-1. */
@Component
class Cookies(
    private val properties: AppProperties,
) {
    companion object {
        const val GUEST = "guest_id"
        const val SESSION = "session"
        const val LOGIN_STATE = "login_state"
        const val LOGIN_STATE_PATH = "/api/v1/account/auth/"
    }

    fun read(
        request: HttpServletRequest,
        name: String,
    ): String? =
        request.cookies
            ?.firstOrNull { it.name == name }
            ?.value
            ?.takeIf { it.isNotEmpty() }

    fun setGuest(
        response: HttpServletResponse,
        value: String,
    ) = add(response, GUEST, value, Duration.ofDays(365))

    fun setSession(
        response: HttpServletResponse,
        value: String,
    ) = add(response, SESSION, value, properties.session.ttl)

    fun clearSession(response: HttpServletResponse) = add(response, SESSION, "", Duration.ZERO)

    /** Login progress cookie: 10 minutes, scoped to the auth path. */
    fun setLoginState(
        response: HttpServletResponse,
        value: String,
    ) = add(response, LOGIN_STATE, value, Duration.ofMinutes(10), LOGIN_STATE_PATH, withDomain = false)

    fun clearLoginState(response: HttpServletResponse) = add(response, LOGIN_STATE, "", Duration.ZERO, LOGIN_STATE_PATH, withDomain = false)

    private fun add(
        response: HttpServletResponse,
        name: String,
        value: String,
        maxAge: Duration,
        path: String = "/",
        sameSite: String = "Lax",
        withDomain: Boolean = true,
    ) {
        val cookie =
            ResponseCookie
                .from(name, value)
                .path(path)
                .httpOnly(true)
                // SameSite=None is only accepted together with Secure.
                .secure(properties.cookie.secure || sameSite == "None")
                .sameSite(sameSite)
                .maxAge(maxAge)
                .apply { if (withDomain && properties.cookie.domain.isNotBlank()) domain(properties.cookie.domain) }
                .build()
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString())
    }
}

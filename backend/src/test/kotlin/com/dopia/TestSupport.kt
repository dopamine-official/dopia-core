package com.dopia

import com.dopia.account.AccountService
import org.springframework.mock.web.MockHttpServletResponse
import java.util.UUID

/** Every required TW consent at its current version (`i18n/regions/TW.json`). */
const val AGREE_ALL = """{"items":[{"id":"terms","version":"2026-11-10"},{"id":"privacy","version":"2026-11-10"}]}"""

/**
 * Logs [guest] in as a fresh member of its own through the real login transaction, in-process.
 * Returns the member ID and the session cookie value for the test's requests.
 */
fun AccountService.loginFresh(guest: UUID): Pair<String, String> {
    val response = MockHttpServletResponse()
    val profile = AccountService.ProviderProfile("google", "test-${UUID.randomUUID()}", "Tester ${UUID.randomUUID()}", null)
    val member = completeLogin(profile, guest, response)
    return member.toString() to response.getCookie("session")!!.value
}

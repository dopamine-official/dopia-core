package com.dopia.dev

import com.dopia.account.AccountService
import com.dopia.account.AccountView
import com.dopia.character.CharacterService
import com.dopia.common.ApiException
import com.dopia.common.AppEvent
import com.dopia.common.AppEvents
import com.dopia.common.Cookies
import com.dopia.common.FieldError
import com.dopia.common.Identity
import com.dopia.common.PreviewScenario
import com.dopia.common.Scenario
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.context.annotation.Profile
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class MockLoginRequest(val provider: String?)
data class ScenarioRequest(val response: String?, val home: String?)

/**
 * Development helpers the web preview page uses: provider-less login, response scenarios,
 * recent events and a full reset. Only registered with the dev profile.
 */
@RestController
@Profile("dev")
@RequestMapping("/api/v1/mock")
class MockController(
    private val accounts: AccountService,
    private val characters: CharacterService,
    private val scenario: PreviewScenario,
    private val events: AppEvents,
    private val cookies: Cookies,
    private val jdbc: JdbcClient,
    private val tx: TransactionTemplate,
) {
    @PostMapping("/login")
    fun login(identity: Identity, @RequestBody body: MockLoginRequest, response: HttpServletResponse): AccountView {
        val provider = body.provider?.takeIf { it == "google" || it == "apple" }
            ?: throw ApiException.invalidInput(FieldError("provider", "invalid"))
        if (identity.isMember) return accounts.me(identity)
        val profile = AccountService.ProviderProfile(provider, "mock-$provider", null, null)
        val memberId = accounts.completeLogin(profile, identity.accountId, response)
        return accounts.me(Identity(memberId, isGuest = false, adultMode = false))
    }

    @GetMapping("/scenario")
    fun scenario(identity: Identity): Scenario = scenario.get()

    @PutMapping("/scenario")
    fun setScenario(identity: Identity, @RequestBody body: ScenarioRequest): Scenario {
        val response = body.response?.takeIf { it in Scenario.RESPONSES } ?: throw ApiException.invalidInput(FieldError("response", "invalid"))
        val home = body.home?.takeIf { it in Scenario.HOMES } ?: throw ApiException.invalidInput(FieldError("home", "invalid"))
        val next = Scenario(response, home)
        scenario.set(next)
        return next
    }

    @GetMapping("/events")
    fun events(identity: Identity): List<AppEvent> = events.forAccount(identity.accountId)

    @PostMapping("/reset")
    fun reset(request: HttpServletRequest, response: HttpServletResponse): AccountView {
        tx.execute {
            jdbc.sql("TRUNCATE chat_turns, chat_summaries, chat_messages, chat_rooms, sessions, account_identities, guest_identifiers, accounts").update()
        }
        events.clear()
        scenario.reset()
        characters.clearCache()
        cookies.clearSession(response)
        val guestId = accounts.createGuest(response)
        return accounts.me(Identity(guestId, isGuest = true, adultMode = false))
    }
}

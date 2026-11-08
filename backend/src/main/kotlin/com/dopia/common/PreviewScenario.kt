package com.dopia.common

import org.springframework.stereotype.Component
import java.util.concurrent.atomic.AtomicReference

/** Next-response and home-list behaviour chosen on the web preview page. Changed only by dev endpoints. */
data class Scenario(val response: String = "normal", val home: String = "normal") {
    companion object {
        val RESPONSES = setOf("normal", "slow", "fail", "disconnect")
        val HOMES = setOf("normal", "empty", "error")
    }
}

@Component
class PreviewScenario {
    private val state = AtomicReference(Scenario())

    fun get(): Scenario = state.get()
    fun set(next: Scenario) = state.set(next)
    fun reset() = state.set(Scenario())

    /** Returns the current response behaviour; one-shot behaviours revert to normal. */
    fun takeResponse(): String {
        val current = state.get()
        if (current.response == "fail" || current.response == "disconnect") state.set(current.copy(response = "normal"))
        return current.response
    }

    /** Returns true once when the home list should fail, then reverts. */
    fun takeHomeFailure(): Boolean {
        val current = state.get()
        if (current.home != "error") return false
        state.set(current.copy(home = "normal"))
        return true
    }
}

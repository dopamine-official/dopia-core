package com.dopia.character

import com.dopia.common.ApiException
import com.dopia.common.Identity
import com.dopia.common.PreviewScenario
import com.dopia.common.RequestLocale
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class HomeController(
    private val characters: CharacterService,
    private val scenario: PreviewScenario,
) {
    @GetMapping("/api/v1/home")
    fun home(
        identity: Identity,
        locale: RequestLocale,
    ): ResponseEntity<HomeResponse> {
        val preview = scenario.get()
        if (scenario.takeHomeFailure()) throw ApiException("unavailable", HttpStatus.SERVICE_UNAVAILABLE, message = "preview: home failure")
        val body = if (preview.home == "empty") HomeResponse(null, emptyList()) else characters.home(identity, locale)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(body)
    }
}

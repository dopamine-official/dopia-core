package com.dopia.account

import com.dopia.common.ApiException
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RequestPart
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.multipart.MultipartFile

data class AdultModeRequest(
    val adultMode: Boolean?,
)

data class AdultVerificationRequest(
    val gender: String?,
    val birthDate: String?,
)

data class ConsentRequest(
    val items: List<ConsentRequestItem>?,
)

data class ConsentRequestItem(
    val id: String?,
    val version: String?,
)

@RestController
@RequestMapping("/api/v1/account")
class AccountController(
    private val service: AccountService,
) {
    @PostMapping("/guest")
    fun guest(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): IssuedAccount = service.issueGuest(request, response)

    @GetMapping("/me")
    fun me(
        identity: Identity,
        locale: RequestLocale,
    ): AccountView = service.me(identity, locale.region)

    @PatchMapping("/me", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun updateProfile(
        identity: Identity,
        locale: RequestLocale,
        @RequestParam(required = false) nickname: String?,
        @RequestPart(required = false) photo: MultipartFile?,
    ): AccountView = service.updateProfile(identity, nickname, photo?.takeIf { !it.isEmpty }?.bytes, locale.region)

    @PatchMapping("/me/adult_mode", consumes = [MediaType.APPLICATION_JSON_VALUE])
    fun updateAdultMode(
        identity: Identity,
        locale: RequestLocale,
        @RequestBody body: AdultModeRequest,
    ): AccountView {
        val value = body.adultMode ?: throw ApiException.invalidInput(com.dopia.common.FieldError("adult_mode", "required"))
        return service.updateAdultMode(identity, value, locale.region)
    }

    @PostMapping("/me/adult_verification", consumes = [MediaType.APPLICATION_JSON_VALUE])
    fun verifyAdult(
        identity: Identity,
        locale: RequestLocale,
        @RequestBody body: AdultVerificationRequest,
    ): AccountView = service.verifyAdult(identity, body.gender, body.birthDate, locale.region)

    @PostMapping("/me/consents", consumes = [MediaType.APPLICATION_JSON_VALUE])
    fun recordConsents(
        identity: Identity,
        locale: RequestLocale,
        @RequestBody body: ConsentRequest,
    ): AccountView {
        val items =
            body.items?.map {
                val id = it.id ?: throw ApiException.invalidInput(com.dopia.common.FieldError("items.id", "required"))
                val version = it.version ?: throw ApiException.invalidInput(com.dopia.common.FieldError("items.version", "required"))
                id to version
            } ?: throw ApiException.invalidInput(com.dopia.common.FieldError("items", "required"))
        return service.recordConsents(identity, items, locale.region)
    }

    @PostMapping("/logout")
    fun logout(
        identity: Identity,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): IssuedAccount = service.logout(identity, request, response, withdraw = false)

    @PostMapping("/withdraw")
    fun withdraw(
        identity: Identity,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): IssuedAccount = service.logout(identity, request, response, withdraw = true)
}

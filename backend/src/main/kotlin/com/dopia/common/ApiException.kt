package com.dopia.common

import org.springframework.http.HttpStatus

data class FieldError(
    val field: String,
    val reason: String,
)

/** An HTTP error the web contract knows how to show. */
class ApiException(
    val code: String,
    val status: HttpStatus,
    val detail: List<FieldError> = emptyList(),
    override val message: String = code.replace('_', ' '),
) : RuntimeException(message) {
    companion object {
        fun unauthorized() = ApiException("unauthorized", HttpStatus.UNAUTHORIZED, message = "no valid guest or session cookie")

        fun invalidInput(vararg errors: FieldError) =
            ApiException("invalid_input", HttpStatus.UNPROCESSABLE_CONTENT, errors.toList(), "request validation failed")
    }
}

data class ErrorBody(
    val code: String,
    val message: String,
    val detail: List<FieldError>,
)

package com.dopia.common

import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.HttpRequestMethodNotSupportedException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.multipart.MaxUploadSizeExceededException
import org.springframework.web.multipart.support.MissingServletRequestPartException
import org.springframework.web.servlet.resource.NoResourceFoundException

@RestControllerAdvice
class ErrorHandler {
    private val log = LoggerFactory.getLogger(ErrorHandler::class.java)

    @ExceptionHandler(ApiException::class)
    fun api(error: ApiException): ResponseEntity<ErrorBody> =
        ResponseEntity.status(error.status).body(ErrorBody(error.code, error.message, error.detail))

    @ExceptionHandler(
        HttpMessageNotReadableException::class,
        MissingServletRequestParameterException::class,
        MissingServletRequestPartException::class,
    )
    fun unreadable(error: Exception): ResponseEntity<ErrorBody> =
        ResponseEntity.status(HttpStatus.UNPROCESSABLE_CONTENT)
            .body(ErrorBody("invalid_input", "request body could not be read", emptyList()))

    @ExceptionHandler(MaxUploadSizeExceededException::class)
    fun tooLarge(error: MaxUploadSizeExceededException): ResponseEntity<ErrorBody> =
        ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
            .body(ErrorBody("file_too_large", "upload exceeds the size limit", emptyList()))

    @ExceptionHandler(NoResourceFoundException::class)
    fun notFound(error: NoResourceFoundException): ResponseEntity<ErrorBody> =
        ResponseEntity.status(HttpStatus.NOT_FOUND).body(ErrorBody("not_found", "no such endpoint", emptyList()))

    @ExceptionHandler(HttpRequestMethodNotSupportedException::class)
    fun method(error: HttpRequestMethodNotSupportedException): ResponseEntity<ErrorBody> =
        ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
            .body(ErrorBody("method_not_allowed", "method not allowed", emptyList()))

    @ExceptionHandler(Exception::class)
    fun other(error: Exception): ResponseEntity<ErrorBody> {
        log.error("unhandled error", error)
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ErrorBody("internal_error", "unexpected server error", emptyList()))
    }
}

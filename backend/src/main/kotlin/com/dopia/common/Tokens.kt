package com.dopia.common

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

object Tokens {
    private val random = SecureRandom()

    /** 256-bit random value for cookies. Only its hash is stored. */
    fun random(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
}

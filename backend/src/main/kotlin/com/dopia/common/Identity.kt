package com.dopia.common

import java.util.UUID

/** Result of ACCOUNT request identification (4-1-2), shared with the other domains. */
data class Identity(
    val accountId: UUID,
    val isGuest: Boolean,
    val adultMode: Boolean,
) {
    val isMember get() = !isGuest
}

/**
 * An endpoint the account may call only after agreeing to the region's required consents
 * (ACCOUNT 4-1-8). Identification answers 403 `consent_required` otherwise.
 */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
annotation class RequiresConsent

/** An endpoint only members may call (CHAT 4-1-1, 4-1-3). Identification answers 403 `member_required` to a guest. */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
annotation class RequiresMember

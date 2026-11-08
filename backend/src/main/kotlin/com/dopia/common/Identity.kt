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

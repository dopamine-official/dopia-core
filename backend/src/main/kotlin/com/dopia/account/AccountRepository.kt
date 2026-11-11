package com.dopia.account

import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID

data class AccountRow(
    val id: UUID,
    val isGuest: Boolean,
    val nickname: String?,
    val photoUrl: String?,
    val adultMode: Boolean,
    val adultVerifiedAt: Instant?,
    val birthDate: LocalDate?,
    val deletedAt: Instant?,
)

@Repository
class AccountRepository(
    private val jdbc: JdbcClient,
) {
    private val columns =
        "id, is_guest, nickname, photo_url, adult_mode, adult_verified_at, birth_date, deleted_at"

    private val account =
        RowMapper { rs: ResultSet, _: Int ->
            AccountRow(
                id = rs.getObject("id", UUID::class.java),
                isGuest = rs.getBoolean("is_guest"),
                nickname = rs.getString("nickname"),
                photoUrl = rs.getString("photo_url"),
                adultMode = rs.getBoolean("adult_mode"),
                adultVerifiedAt = rs.getObject("adult_verified_at", OffsetDateTime::class.java)?.toInstant(),
                birthDate = rs.getObject("birth_date", LocalDate::class.java),
                deletedAt = rs.getObject("deleted_at", OffsetDateTime::class.java)?.toInstant(),
            )
        }

    fun find(id: UUID): AccountRow? =
        jdbc
            .sql("SELECT $columns FROM accounts WHERE id = :id")
            .param("id", id)
            .query(account)
            .optional()
            .orElse(null)

    fun createdAt(id: UUID): java.time.Instant? =
        jdbc
            .sql("SELECT created_at FROM accounts WHERE id = :id")
            .param("id", id)
            .query(java.time.Instant::class.java)
            .optional()
            .orElse(null)

    fun lock(id: UUID): AccountRow? =
        jdbc
            .sql("SELECT $columns FROM accounts WHERE id = :id FOR UPDATE")
            .param("id", id)
            .query(account)
            .optional()
            .orElse(null)

    fun findBySession(tokenHash: String): AccountRow? =
        jdbc
            .sql(
                """
            SELECT ${columns.split(", ").joinToString(", ") { "a.$it" }}
            FROM sessions s JOIN accounts a ON a.id = s.account_id
            WHERE s.token_hash = :hash AND s.revoked_at IS NULL AND s.expires_at > now() AND a.deleted_at IS NULL
            """,
            ).param("hash", tokenHash)
            .query(account)
            .optional()
            .orElse(null)

    fun findByGuestToken(tokenHash: String): AccountRow? =
        jdbc
            .sql(
                """
            SELECT ${columns.split(", ").joinToString(", ") { "a.$it" }}
            FROM guest_identifiers g JOIN accounts a ON a.id = g.account_id
            WHERE g.token_hash = :hash AND a.deleted_at IS NULL
            """,
            ).param("hash", tokenHash)
            .query(account)
            .optional()
            .orElse(null)

    fun touchGuest(accountId: UUID) {
        jdbc
            .sql("UPDATE guest_identifiers SET last_seen_at = now() WHERE account_id = :id AND last_seen_at < now() - interval '1 day'")
            .param("id", accountId)
            .update()
    }

    fun insertGuest(tokenHash: String): UUID {
        val id =
            jdbc
                .sql("INSERT INTO accounts (is_guest) VALUES (true) RETURNING id")
                .query(UUID::class.java)
                .single()
        jdbc
            .sql("INSERT INTO guest_identifiers (account_id, token_hash) VALUES (:id, :hash)")
            .param("id", id)
            .param("hash", tokenHash)
            .update()
        return id
    }

    /** The guest's cookie identifies no one any more (login, ACCOUNT 4-1-4). */
    fun deleteGuestIdentifier(accountId: UUID) {
        jdbc.sql("DELETE FROM guest_identifiers WHERE account_id = :id").param("id", accountId).update()
    }

    fun insertMember(
        nickname: String,
        email: String?,
    ): UUID =
        jdbc
            .sql("INSERT INTO accounts (is_guest, nickname, email, last_login_at) VALUES (false, :nickname, :email, now()) RETURNING id")
            .param("nickname", nickname)
            .param("email", email)
            .query(UUID::class.java)
            .single()

    fun nicknameTaken(
        nickname: String,
        except: UUID?,
    ): Boolean =
        jdbc
            .sql(
                "SELECT count(*) FROM accounts WHERE lower(nickname) = lower(:nickname) AND deleted_at IS NULL " +
                    "AND (:except::uuid IS NULL OR id <> :except::uuid)",
            ).param("nickname", nickname)
            .param("except", except)
            .query(Long::class.java)
            .single() > 0

    fun updateProfile(
        id: UUID,
        nickname: String?,
        photoUrl: String?,
    ) {
        jdbc
            .sql(
                "UPDATE accounts SET nickname = coalesce(:nickname, nickname), photo_url = coalesce(:photo, photo_url) WHERE id = :id",
            ).param("id", id)
            .param("nickname", nickname)
            .param("photo", photoUrl)
            .update()
    }

    /** True when the value actually changed. */
    fun updateAdultMode(
        id: UUID,
        adultMode: Boolean,
    ): Boolean =
        jdbc
            .sql("UPDATE accounts SET adult_mode = :value WHERE id = :id AND adult_mode IS DISTINCT FROM :value")
            .param("id", id)
            .param("value", adultMode)
            .update() > 0

    /**
     * Stores the one adult verification submission (4-1-7). Only a row without a birth date is
     * updated, so a second or concurrent submission changes nothing and returns false.
     */
    fun submitAdultVerification(
        id: UUID,
        gender: String,
        birthDate: LocalDate,
        verified: Boolean,
    ): Boolean =
        jdbc
            .sql(
                """
            UPDATE accounts SET gender = :gender, birth_date = :birth,
                adult_verified_at = CASE WHEN :verified THEN now() ELSE adult_verified_at END,
                adult_mode = adult_mode OR :verified
            WHERE id = :id AND birth_date IS NULL AND NOT is_guest
            """,
            ).param("id", id)
            .param("gender", gender)
            .param("birth", birthDate)
            .param("verified", verified)
            .update() > 0

    fun markDeleted(id: UUID) {
        jdbc.sql("UPDATE accounts SET deleted_at = now(), adult_mode = false WHERE id = :id").param("id", id).update()
    }

    fun touchLogin(id: UUID) {
        jdbc.sql("UPDATE accounts SET last_login_at = now() WHERE id = :id").param("id", id).update()
    }

    // Identities

    fun findIdentityAccount(
        provider: String,
        subject: String,
    ): UUID? =
        jdbc
            .sql("SELECT account_id FROM account_identities WHERE provider = :provider AND provider_subject = :subject FOR UPDATE")
            .param("provider", provider)
            .param("subject", subject)
            .query(UUID::class.java)
            .optional()
            .orElse(null)

    fun upsertIdentity(
        provider: String,
        subject: String,
        accountId: UUID,
    ) {
        jdbc
            .sql(
                """
            INSERT INTO account_identities (provider, provider_subject, account_id) VALUES (:provider, :subject, :account)
            ON CONFLICT (provider, provider_subject) DO UPDATE SET account_id = EXCLUDED.account_id
            """,
            ).param("provider", provider)
            .param("subject", subject)
            .param("account", accountId)
            .update()
    }

    // Sessions

    fun insertSession(
        accountId: UUID,
        tokenHash: String,
        ttlSeconds: Long,
    ) {
        jdbc
            .sql("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (:hash, :account, now() + make_interval(secs => :ttl))")
            .param("hash", tokenHash)
            .param("account", accountId)
            .param("ttl", ttlSeconds)
            .update()
    }

    fun revokeSession(tokenHash: String) {
        jdbc.sql("UPDATE sessions SET revoked_at = now() WHERE token_hash = :hash AND revoked_at IS NULL").param("hash", tokenHash).update()
    }

    fun revokeAllSessions(accountId: UUID) {
        jdbc.sql("UPDATE sessions SET revoked_at = now() WHERE account_id = :id AND revoked_at IS NULL").param("id", accountId).update()
    }

    fun deleteDeadSessions() {
        jdbc.sql("DELETE FROM sessions WHERE expires_at < now() OR revoked_at < now() - interval '1 day'").update()
    }

    // Consents (3-2-7)

    /** The (id, version) pairs this account agreed to. */
    fun consents(accountId: UUID): Set<Pair<String, String>> =
        jdbc
            .sql("SELECT consent_id, version FROM account_consents WHERE account_id = :id")
            .param("id", accountId)
            .query { rs, _ -> rs.getString("consent_id") to rs.getString("version") }
            .set()

    /** True when the record is new: an item and version already agreed to stays as it was. */
    fun insertConsent(
        accountId: UUID,
        consentId: String,
        version: String,
    ): Boolean =
        jdbc
            .sql(
                "INSERT INTO account_consents (account_id, consent_id, version) VALUES (:account, :consent, :version) " +
                    "ON CONFLICT DO NOTHING",
            ).param("account", accountId)
            .param("consent", consentId)
            .param("version", version)
            .update() > 0

    /** The latest agreed version of each item (TRACKING-PLAN 8-4). */
    fun agreedVersions(accountId: UUID): Map<String, String> =
        jdbc
            .sql(
                """
            SELECT DISTINCT ON (consent_id) consent_id, version FROM account_consents
            WHERE account_id = :id ORDER BY consent_id, agreed_at DESC, version DESC
            """,
            ).param("id", accountId)
            .query { rs, _ -> rs.getString("consent_id") to rs.getString("version") }
            .list()
            .toMap()

    /** Gender, birth date and whether the verification passed; null before any submission. */
    fun verification(accountId: UUID): Triple<String, LocalDate, Boolean>? =
        jdbc
            .sql(
                "SELECT gender, birth_date, adult_verified_at IS NOT NULL AS passed FROM accounts WHERE id = :id AND birth_date IS NOT NULL",
            ).param("id", accountId)
            .query { rs, _ ->
                Triple(rs.getString("gender"), rs.getObject("birth_date", LocalDate::class.java), rs.getBoolean("passed"))
            }.optional()
            .orElse(null)

    /** Copies every consent of [from] to [to] with its original time; ones [to] already has stay. */
    fun copyConsents(
        from: UUID,
        to: UUID,
    ) {
        jdbc
            .sql(
                """
            INSERT INTO account_consents (account_id, consent_id, version, agreed_at)
            SELECT :to, consent_id, version, agreed_at FROM account_consents WHERE account_id = :from
            ON CONFLICT DO NOTHING
            """,
            ).param("from", from)
            .param("to", to)
            .update()
    }
}

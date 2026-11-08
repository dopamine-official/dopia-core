package com.dopia.config

import org.springframework.boot.SpringApplication
import org.springframework.boot.EnvironmentPostProcessor
import org.springframework.core.env.ConfigurableEnvironment
import org.springframework.core.env.MapPropertySource
import java.net.URLDecoder

/**
 * Accepts Supabase's connection string as DATABASE_URL (postgresql://user:pass@host:port/db)
 * and turns it into the JDBC url, username and password the datasource needs.
 */
class DatabaseUrlPostProcessor : EnvironmentPostProcessor {
    override fun postProcessEnvironment(environment: ConfigurableEnvironment, application: SpringApplication) {
        // Cloudflare R2 is used as soon as a bucket is named, unless STORAGE_MODE says otherwise.
        if (!environment.getProperty("R2_BUCKET").isNullOrBlank() && environment.getProperty("STORAGE_MODE").isNullOrBlank()) {
            environment.propertySources.addFirst(MapPropertySource("storageMode", mapOf("app.storage.mode" to "r2")))
        }
        val raw = environment.getProperty("DATABASE_URL")?.trim()?.takeIf { it.isNotEmpty() } ?: return
        if (!raw.startsWith("postgres://") && !raw.startsWith("postgresql://")) return
        // Parsed by hand: passwords may contain characters such as '#' that java.net.URI misreads.
        val rest = raw.substringAfter("://")
        val at = rest.lastIndexOf('@')
        if (at < 0) return
        val userInfo = rest.substring(0, at)
        val hostAndPath = rest.substring(at + 1)
        val username = URLDecoder.decode(userInfo.substringBefore(':'), Charsets.UTF_8)
        val password = URLDecoder.decode(userInfo.substringAfter(':', ""), Charsets.UTF_8)
        val hostPort = hostAndPath.substringBefore('/')
        val path = hostAndPath.substringAfter('/', "postgres")
        val host = hostPort.substringBefore(':')
        val port = hostPort.substringAfter(':', "5432")
        environment.propertySources.addFirst(
            MapPropertySource(
                "databaseUrl",
                mapOf(
                    "spring.datasource.url" to "jdbc:postgresql://$host:$port/$path",
                    "spring.datasource.username" to username,
                    "spring.datasource.password" to password,
                ),
            ),
        )
    }
}

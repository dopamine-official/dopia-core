package com.dopia.common

import com.dopia.config.AppProperties
import org.springframework.core.io.ClassPathResource
import org.springframework.stereotype.Component
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.time.ZoneId

/** Region config and locale resolution per COMMON/I18N/I18N.md. Files are copies of the web bundle. */
data class RegionConfig(
    val code: String,
    val defaultLocale: String,
    val supportedLocales: List<String>,
    val adultModeAvailable: Boolean,
    val adultAge: Int? = null,
    val verificationMethod: String? = null,
    /** Whose calendar day the age is counted on (`age.time_zone`). */
    val timeZone: ZoneId? = null,
    val consentItems: List<ConsentItem> = emptyList(),
)

/** One `consent.items[]` entry, also sent to the web as is. */
data class ConsentItem(
    val id: String,
    val required: Boolean,
    val version: String,
    val documentUrl: String,
)

@Component
class I18n(
    mapper: ObjectMapper,
    properties: AppProperties,
) {
    private val defaultRegion: String
    private val regions: Map<String, RegionConfig>

    init {
        val index = mapper.readTree(ClassPathResource("i18n/regions/index.json").inputStream)
        val profiles = mapper.readTree(ClassPathResource("i18n/profiles.json").inputStream)
        val overlay =
            profiles.get(properties.regionProfile)
                ?: error("Unknown region profile: ${properties.regionProfile}")
        defaultRegion = index.get("default_region").asString()
        regions =
            index.get("regions").values().map { it.asString() }.associateWith { code ->
                val base = mapper.readTree(ClassPathResource("i18n/regions/$code.json").inputStream)
                val locale = overlay.get("locale") ?: base.get("locale")
                RegionConfig(
                    code = code,
                    defaultLocale = locale.get("default").asString(),
                    supportedLocales = locale.get("supported").values().map { it.asString() },
                    adultModeAvailable = base.path("content").path("adult_mode_available").asBoolean(false),
                    adultAge =
                        base
                            .path("age")
                            .path("adult_age")
                            .takeIf { it.isNumber }
                            ?.asInt(),
                    verificationMethod =
                        base
                            .path("age")
                            .path("verification_method")
                            .takeIf { it.isString }
                            ?.asString(),
                    timeZone =
                        base
                            .path("age")
                            .path("time_zone")
                            .takeIf { it.isString }
                            ?.let { ZoneId.of(it.asString()) },
                    consentItems =
                        base.path("consent").path("items").values().map {
                            ConsentItem(
                                it.get("id").asString(),
                                it.get("required").asBoolean(),
                                it.get("version").asString(),
                                it.path("document_url").asString(""),
                            )
                        },
                )
            }
    }

    /** Unknown or disabled regions fall back to the deployment default. */
    fun region(requested: String?): RegionConfig = regions[requested] ?: regions.getValue(defaultRegion)

    /** Exact locale, then same language, then the region default. */
    fun resolveLocale(
        requested: String?,
        region: RegionConfig,
    ): String {
        val language = requested?.substringBefore('-')
        return region.supportedLocales.firstOrNull { it == requested }
            ?: region.supportedLocales.firstOrNull { it.substringBefore('-') == language }
            ?: region.defaultLocale
    }

    companion object {
        /** Localized text: requested locale, then same language, then the source locale. */
        fun resolveText(
            texts: JsonNode,
            sourceLocale: String,
            locale: String,
        ): String {
            texts
                .get(locale)
                ?.asString()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }
            val language = locale.substringBefore('-')
            for ((key, value) in texts.properties()) {
                if (key.substringBefore('-') == language && value.asString().isNotEmpty()) return value.asString()
            }
            return texts.get(sourceLocale)?.asString().orEmpty()
        }
    }
}

/** Locale and region resolved from the request headers for this request. */
data class RequestLocale(
    val locale: String,
    val region: RegionConfig,
)

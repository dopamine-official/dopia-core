package com.dopia.config

import com.dopia.account.AccountService
import com.dopia.account.LocalDiskPhotoStorage
import com.dopia.common.I18n
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import com.dopia.common.RequiresConsent
import jakarta.servlet.http.HttpServletRequest
import org.springframework.context.annotation.Configuration
import org.springframework.core.MethodParameter
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

/** Controllers receive the identified account and the resolved locale as plain arguments. */
@Configuration
class WebConfig(
    private val accounts: AccountService,
    private val i18n: I18n,
    private val storage: LocalDiskPhotoStorage,
    private val properties: AppProperties,
) : WebMvcConfigurer {
    override fun addArgumentResolvers(resolvers: MutableList<HandlerMethodArgumentResolver>) {
        resolvers.add(
            object : HandlerMethodArgumentResolver {
                override fun supportsParameter(parameter: MethodParameter) = parameter.parameterType == Identity::class.java

                override fun resolveArgument(
                    parameter: MethodParameter,
                    container: ModelAndViewContainer?,
                    request: NativeWebRequest,
                    binder: WebDataBinderFactory?,
                ): Any {
                    val http = request.getNativeRequest(HttpServletRequest::class.java)!!
                    val identity = accounts.identify(http)
                    if (parameter.hasMethodAnnotation(RequiresConsent::class.java)) {
                        accounts.assertConsented(identity, i18n.region(http.getHeader("X-Region")))
                    }
                    return identity
                }
            },
        )
        resolvers.add(
            object : HandlerMethodArgumentResolver {
                override fun supportsParameter(parameter: MethodParameter) = parameter.parameterType == RequestLocale::class.java

                override fun resolveArgument(
                    parameter: MethodParameter,
                    container: ModelAndViewContainer?,
                    request: NativeWebRequest,
                    binder: WebDataBinderFactory?,
                ): Any {
                    val region = i18n.region(request.getHeader("X-Region"))
                    return RequestLocale(i18n.resolveLocale(request.getHeader("X-Locale"), region), region)
                }
            },
        )
    }

    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        // Local photo storage is served by the server itself; Supabase Storage serves its own URLs.
        val base = properties.storage.publicBaseUrl
        if (base.startsWith("/")) {
            registry.addResourceHandler("${base.trimEnd('/')}/**").addResourceLocations(storage.root.toUri().toString())
        }
    }
}

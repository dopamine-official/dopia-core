package com.dopia.account

import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Primary
import org.springframework.stereotype.Component
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.core.sync.RequestBody
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.S3Configuration
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest
import software.amazon.awssdk.services.s3.model.PutObjectRequest
import java.net.URI
import java.util.UUID

/** Cloudflare R2 public bucket over the S3 API. Selected when R2_BUCKET is set. */
@Component
@Primary
@ConditionalOnProperty(prefix = "app.storage", name = ["mode"], havingValue = "r2")
class R2PhotoStorage(private val properties: AppProperties) : PhotoStorage {
    private val log = LoggerFactory.getLogger(R2PhotoStorage::class.java)
    private val storage = properties.storage
    private val publicBase = storage.r2PublicBaseUrl.trimEnd('/')
    private val client: S3Client = S3Client.builder()
        .region(Region.of("auto"))
        .endpointOverride(URI("https://${storage.r2AccountId}.r2.cloudflarestorage.com"))
        .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(storage.r2AccessKeyId, storage.r2SecretAccessKey)))
        .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
        .httpClientBuilder(UrlConnectionHttpClient.builder())
        .build()

    init {
        require(publicBase.isNotEmpty()) { "R2_PUBLIC_BASE_URL is required with R2_BUCKET" }
    }

    override fun store(accountId: UUID, bytes: ByteArray, type: ImageType): String {
        val key = "profiles/$accountId/${UUID.randomUUID()}.${type.extension}"
        client.putObject(
            PutObjectRequest.builder().bucket(storage.r2Bucket).key(key)
                .contentType("image/${if (type == ImageType.JPEG) "jpeg" else type.extension}")
                .cacheControl("public, max-age=31536000, immutable").build(),
            RequestBody.fromBytes(bytes),
        )
        return "$publicBase/$key"
    }

    override fun delete(url: String) {
        if (!url.startsWith("$publicBase/")) return
        runCatching {
            client.deleteObject(DeleteObjectRequest.builder().bucket(storage.r2Bucket).key(url.removePrefix("$publicBase/")).build())
        }.onFailure { log.warn("could not delete {}", url, it) }
    }
}

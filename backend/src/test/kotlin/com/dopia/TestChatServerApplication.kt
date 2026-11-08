package com.dopia

import org.springframework.boot.fromApplication
import org.springframework.boot.with

fun main(args: Array<String>) {
    fromApplication<ChatServerApplication>().with(TestcontainersConfiguration::class).run(*args)
}

package br.com.treinofit

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.net.URLDecoder

class ApiServer(
    port: Int,
    private val gifsDir: File,
    private val openAsset: (String) -> ByteArray?
) : NanoHTTPD("127.0.0.1", port) {

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val decodedUri = runCatching { URLDecoder.decode(uri, "UTF-8") }.getOrDefault(uri)

        // 1. Status API
        if (decodedUri == "/api/status") {
            val gifFiles = gifsDir.listFiles { f -> f.extension.equals("gif", ignoreCase = true) }
            val count = gifFiles?.size ?: 0
            val json = JSONObject().apply {
                put("status", "ok")
                put("localGifsCount", count)
                put("path", gifsDir.absolutePath)
            }
            return newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", json.toString())
                .also { it.addHeader("Cache-Control", "no-store") }
        }

        // 2. Servir GIFs locais (/gifs/...)
        if (decodedUri.startsWith("/gifs/")) {
            val filename = decodedUri.removePrefix("/gifs/").trimStart('/')
            val gifFile = if (File(gifsDir, filename).exists()) {
                File(gifsDir, filename)
            } else {
                gifsDir.listFiles()?.firstOrNull { it.name.equals(filename, ignoreCase = true) }
                    ?: File("/sdcard/Android/data/br.com.treinofit/files/gifs", filename)
            }

            if (gifFile.exists() && gifFile.isFile && gifFile.length() > 0) {
                val stream = FileInputStream(gifFile)
                return newFixedLengthResponse(
                    Response.Status.OK,
                    "image/gif",
                    stream,
                    gifFile.length()
                ).also {
                    it.addHeader("Access-Control-Allow-Origin", "*")
                    it.addHeader("Cache-Control", "public, max-age=31536000")
                }
            }

            // Fallback: verificar se está empacotado em assets/gifs/
            val assetData = openAsset("gifs/$filename")
            if (assetData != null) {
                return newFixedLengthResponse(
                    Response.Status.OK,
                    "image/gif",
                    ByteArrayInputStream(assetData),
                    assetData.size.toLong()
                ).also {
                    it.addHeader("Access-Control-Allow-Origin", "*")
                    it.addHeader("Cache-Control", "public, max-age=31536000")
                }
            }

            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "GIF not found: $filename")
        }

        // 3. Servir arquivos estáticos da SPA (assets/)
        val assetPath = when {
            decodedUri == "/" || decodedUri.isEmpty() -> "index.html"
            decodedUri.startsWith("/") -> decodedUri.substring(1)
            else -> decodedUri
        }

        val bytes = openAsset(assetPath)
        if (bytes != null) {
            val mime = when {
                assetPath.endsWith(".html") -> "text/html; charset=utf-8"
                assetPath.endsWith(".css") -> "text/css; charset=utf-8"
                assetPath.endsWith(".js") -> "application/javascript; charset=utf-8"
                assetPath.endsWith(".json") -> "application/json; charset=utf-8"
                assetPath.endsWith(".png") -> "image/png"
                assetPath.endsWith(".svg") -> "image/svg+xml"
                assetPath.endsWith(".gif") -> "image/gif"
                else -> "application/octet-stream"
            }
            return newFixedLengthResponse(
                Response.Status.OK,
                mime,
                ByteArrayInputStream(bytes),
                bytes.size.toLong()
            ).also {
                if (assetPath.endsWith(".html")) {
                    it.addHeader("Cache-Control", "no-cache")
                } else {
                    it.addHeader("Cache-Control", "public, max-age=86400")
                }
            }
        }

        return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found")
    }
}

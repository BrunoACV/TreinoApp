package br.com.treinofit

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.ServerSocket
import java.net.URLDecoder

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var server: ApiServer? = null
    private var porta = 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Inicializa servidor HTTP interno escutando somente em 127.0.0.1
        porta = encontrarPortaLivre()
        val gifsDir = obterPastaGifs()

        server = ApiServer(
            port = porta,
            gifsDir = gifsDir,
            openAsset = { caminho ->
                runCatching { assets.open(caminho).readBytes() }.getOrNull()
            }
        ).also { it.start(5000, false) }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.statusBarColor = 0xFF000000.toInt()
            window.navigationBarColor = 0xFF000000.toInt()
        }

        web = WebView(this)
        setContentView(web)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.setBackgroundColor(0xFF000000.toInt())

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = false
            loadWithOverviewMode = false
            textZoom = 100
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val uri = request?.url ?: return null
                val path = uri.path ?: return null

                // Interceptar requisições para GIFs (/gifs/...)
                if (path.startsWith("/gifs/")) {
                    val rawFilename = path.removePrefix("/gifs/").trimStart('/')
                    val decodedFilename = runCatching { URLDecoder.decode(rawFilename, "UTF-8") }.getOrDefault(rawFilename)

                    val gifsDir = obterPastaGifs()
                    val targetFile = encontrarArquivoGif(gifsDir, decodedFilename)
                        ?: encontrarArquivoGif(gifsDir, rawFilename)
                        ?: encontrarArquivoGif(File("/sdcard/Android/data/br.com.treinofit/files/gifs"), decodedFilename)

                    if (targetFile != null && targetFile.exists() && targetFile.length() > 0) {
                        val headers = mapOf(
                            "Access-Control-Allow-Origin" to "*",
                            "Cache-Control" to "public, max-age=31536000"
                        )
                        return WebResourceResponse(
                            "image/gif",
                            null,
                            200,
                            "OK",
                            headers,
                            FileInputStream(targetFile)
                        )
                    }

                    // Fallback para assets embutidos (assets/gifs/...)
                    try {
                        val assetStream = assets.open("gifs/$decodedFilename")
                        return WebResourceResponse(
                            "image/gif",
                            null,
                            200,
                            "OK",
                            mapOf("Access-Control-Allow-Origin" to "*"),
                            assetStream
                        )
                    } catch (_: Exception) {}

                    android.util.Log.w("TreinoFit", "GIF não localizado: '$decodedFilename' (pasta: ${gifsDir.absolutePath})")
                }

                return super.shouldInterceptRequest(view, request)
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                android.util.Log.e("TreinoFit", "Erro WebViewClient: ${error?.description} em ${request?.url}")
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injetarCoresDinamicas(view)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.d("TreinoFitWeb", "${m.message()} @${m.lineNumber()}")
                return true
            }

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("TreinoFit")
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setCancelable(false)
                    .create()
                    .show()
                return true
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("TreinoFit")
                    .setMessage(message)
                    .setPositiveButton("Sim") { _, _ -> result?.confirm() }
                    .setNegativeButton("Não") { _, _ -> result?.cancel() }
                    .setCancelable(false)
                    .create()
                    .show()
                return true
            }
        }

        web.addJavascriptInterface(AndroidBridge(), "Android")
        web.loadUrl("http://127.0.0.1:$porta/")

        // Tratamento elegante do botão voltar físico/gesto
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__onBack && window.__onBack()) ? 1 : 0") { r ->
                    if (r?.trim() != "1") {
                        finish()
                    }
                }
            }
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        server?.stop()
    }

    private fun encontrarPortaLivre(): Int {
        val portaFixa = 28765
        return try {
            ServerSocket(portaFixa).use { it.localPort }
        } catch (_: Exception) {
            ServerSocket(0).use { it.localPort }
        }
    }

    private fun obterPastaGifs(): File {
        // Prioriza pasta externa do app (/sdcard/Android/data/br.com.treinofit/files/gifs)
        val ext = getExternalFilesDir("gifs")
        if (ext != null && (ext.exists() || ext.mkdirs())) {
            return ext
        }
        // Fallback para armazenamento interno
        val intern = File(filesDir, "gifs")
        if (!intern.exists()) intern.mkdirs()
        return intern
    }

    private fun encontrarArquivoGif(pasta: File, nomeArquivo: String): File? {
        if (!pasta.exists() || !pasta.isDirectory) return null
        val direto = File(pasta, nomeArquivo)
        if (direto.exists() && direto.isFile && direto.length() > 0) return direto

        // Fallback case-insensitive
        val arquivos = pasta.listFiles() ?: return null
        return arquivos.firstOrNull { it.name.equals(nomeArquivo, ignoreCase = true) && it.length() > 0 }
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun saveData(key: String, value: String) {
            try {
                getSharedPreferences("TreinoFitStorage", Context.MODE_PRIVATE)
                    .edit()
                    .putString(key, value)
                    .apply()
            } catch (e: Exception) {
                android.util.Log.e("TreinoFit", "Erro ao persistir dado ($key): ${e.message}")
            }
        }

        @JavascriptInterface
        fun loadData(key: String): String? {
            return try {
                getSharedPreferences("TreinoFitStorage", Context.MODE_PRIVATE)
                    .getString(key, null)
            } catch (e: Exception) {
                android.util.Log.e("TreinoFit", "Erro ao recuperar dado ($key): ${e.message}")
                null
            }
        }

        @JavascriptInterface
        fun removeData(key: String) {
            try {
                getSharedPreferences("TreinoFitStorage", Context.MODE_PRIVATE)
                    .edit()
                    .remove(key)
                    .apply()
            } catch (e: Exception) {
                android.util.Log.e("TreinoFit", "Erro ao remover dado ($key): ${e.message}")
            }
        }

        @JavascriptInterface
        fun toast(mensagem: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, mensagem, Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun vibrate(ms: Long) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                    vibratorManager.defaultVibrator.vibrate(
                        VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
                    )
                } else {
                    @Suppress("DEPRECATION")
                    val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                    } else {
                        @Suppress("DEPRECATION")
                        vibrator.vibrate(ms)
                    }
                }
            } catch (_: Exception) {}
        }

        @JavascriptInterface
        fun keepScreenOn(enable: Boolean) {
            runOnUiThread {
                if (enable) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface
        fun getStorageInfo(): String {
            val pasta = obterPastaGifs()
            val totalGifs = pasta.listFiles { f -> f.extension.equals("gif", ignoreCase = true) }?.size ?: 0
            val json = JSONObject().apply {
                put("gifsPath", pasta.absolutePath)
                put("localGifsCount", totalGifs)
                put("totalExpected", 963)
            }
            return json.toString()
        }

        @JavascriptInterface
        fun getDynamicColors(): String {
            val json = JSONObject()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try {
                    val a500 = getColor(android.R.color.system_accent1_500)
                    val a300 = getColor(android.R.color.system_accent1_300)
                    val a100 = getColor(android.R.color.system_accent1_100)
                    val a600 = getColor(android.R.color.system_accent1_600)

                    val r = (a500 shr 16) and 0xFF
                    val g = (a500 shr 8) and 0xFF
                    val b = a500 and 0xFF
                    val luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
                    val contrast = if (luminance > 0.55) "#000000" else "#FFFFFF"

                    json.put("supported", true)
                    json.put("accentPrimary", colorToHex(a500))
                    json.put("accentPrimaryRgb", "$r, $g, $b")
                    json.put("accentContrast", contrast)
                    json.put("accentLight", colorToHex(a300))
                    json.put("accentSurface", colorToHex(a100))
                    json.put("accentDark", colorToHex(a600))
                    return json.toString()
                } catch (e: Exception) {
                    android.util.Log.e("TreinoFit", "Erro ao extrair cores dinâmicas: ${e.message}")
                }
            }
            json.put("supported", false)
            return json.toString()
        }
    }

    private fun colorToHex(color: Int): String = String.format("#%06X", 0xFFFFFF and color)

    private fun injetarCoresDinamicas(view: WebView?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val a500 = getColor(android.R.color.system_accent1_500)
                val a300 = getColor(android.R.color.system_accent1_300)
                val a100 = getColor(android.R.color.system_accent1_100)
                val a600 = getColor(android.R.color.system_accent1_600)
                val r = (a500 shr 16) and 0xFF
                val g = (a500 shr 8) and 0xFF
                val b = a500 and 0xFF
                val luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
                val contrast = if (luminance > 0.55) "#000000" else "#FFFFFF"
                val hex500 = colorToHex(a500)
                val hex300 = colorToHex(a300)
                val hex100 = colorToHex(a100)
                val hex600 = colorToHex(a600)
                val rgbStr = "$r, $g, $b"

                val js = """
                    if (window.__receiveAndroidDynamicColors) {
                        window.__receiveAndroidDynamicColors({
                            supported: true,
                            accentPrimary: '$hex500',
                            accentPrimaryRgb: '$rgbStr',
                            accentContrast: '$contrast',
                            accentLight: '$hex300',
                            accentSurface: '$hex100',
                            accentDark: '$hex600'
                        });
                    }
                """.trimIndent()
                view?.evaluateJavascript(js, null)
            } catch (e: Exception) {
                android.util.Log.e("TreinoFit", "Erro ao injetar cores dinâmicas: ${e.message}")
            }
        }
    }
}

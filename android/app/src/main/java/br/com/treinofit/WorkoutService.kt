package br.com.treinofit

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Mantém o processo vivo enquanto há treino em andamento (o Android matava o app em
 * segundo plano) e avisa o fim do descanso mesmo com outro app na frente.
 */
class WorkoutService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var title = "Treino"
    private var startedAt = System.currentTimeMillis()
    private var vibrate = true
    private var sound = true

    // Uma trava só, reaproveitada: cada toque em "+" criava outra, e pular o descanso ou sair do treino não soltava nenhuma
    private val restLock by lazy {
        (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "treinofit:descanso")
            .apply { setReferenceCounted(false) }
    }

    private val restDone = Runnable {
        if (vibrate) runCatching {
            @Suppress("DEPRECATION")
            (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
                .vibrate(VibrationEffect.createWaveform(longArrayOf(0, 300, 150, 300), -1))
        }
        if (sound) runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 400)
            handler.postDelayed({ tone.release() }, 800)
        }
        notify("Descanso concluído. Próxima série!")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_REST -> {
                handler.removeCallbacks(restDone)
                val endsAt = intent.getLongExtra(EXTRA_TIME, 0)
                vibrate = intent.getBooleanExtra(EXTRA_VIBRATE, true)
                sound = intent.getBooleanExtra(EXTRA_SOUND, true)
                val delay = endsAt - System.currentTimeMillis()
                if (delay > 0) {
                    // Segura a CPU até o aviso: com a tela apagada o Handler pararia de contar
                    restLock.acquire(delay + 2000) // sem contagem de referência: pedir de novo só troca o prazo
                    handler.postDelayed(restDone, delay)
                    notify("Descansando")
                } else {
                    restLock.release() // descanso pulado ou cancelado
                    notify("Treino em andamento")
                }
            }
            else -> { // ACTION_START, ou o sistema recriando o serviço
                title = intent?.getStringExtra(EXTRA_TITLE) ?: title
                startedAt = intent?.getLongExtra(EXTRA_TIME, startedAt) ?: startedAt
                notify("Treino em andamento")
            }
        }
        return START_NOT_STICKY // recriado sem a página, só mostraria um cronômetro errado
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        restLock.release()
        super.onDestroy()
    }

    private fun notify(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Treino em andamento", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title)
            .setContentText(text)
            .setWhen(startedAt)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        // Se o sistema recusar o primeiro plano, encerra o serviço; o treino é salvo a cada toque e volta ao abrir
        runCatching { ServiceCompat.startForeground(this, 1, n, type) }
            .onFailure {
                android.util.Log.e("TreinoFit", "startForeground falhou: ${it.message}")
                stopSelf()
            }
    }

    companion object {
        const val CHANNEL = "treino"
        const val ACTION_START = "start"
        const val ACTION_REST = "rest"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TIME = "time"
        const val EXTRA_VIBRATE = "vibrate"
        const val EXTRA_SOUND = "sound"
    }
}

package expo.modules.bbplayernative

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** Short, user/scheduler-triggered discovery. Advertisements are hints, never trust anchors. */
internal object LANDiscovery {
    @Suppress("DEPRECATION")
    suspend fun discover(context: Context): List<Map<String, String>> = withContext(Dispatchers.Main) {
        val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        val handler = Handler(Looper.getMainLooper())
        val found = mutableListOf<Map<String, String>>()
        val queue = ArrayDeque<NsdServiceInfo>()
        var closed = false
        var resolving = false
        var failure: String? = null
        var activeResolver: NsdManager.ResolveListener? = null
        lateinit var pump: () -> Unit
        pump = {
            if (!closed && !resolving && queue.isNotEmpty()) {
                resolving = true
                val service = queue.removeFirst()
                val resolver = object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, code: Int) { handler.post { resolving = false; activeResolver = null; pump() } }
                    override fun onServiceResolved(info: NsdServiceInfo) { handler.post {
                        if (!closed) {
                            val host = info.host?.hostAddress
                            if (host != null && PinnedLANClient.isLANAddress(host) && info.port in 1..65535 && found.size < 20) {
                                val authority = if (host.contains(':')) "[$host]" else host
                                found.add(mapOf("name" to info.serviceName.take(128), "endpoint" to "https://$authority:${info.port}"))
                            }
                        }
                        resolving = false; activeResolver = null; pump()
                    } }
                }
                activeResolver = resolver
                manager.resolveService(service, resolver)
            }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { handler.post { failure = "Local network discovery unavailable ($code)" } }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) { handler.post {
                if (!closed && info.serviceType.trimEnd('.') == "_bbplayer-sync._tcp" && queue.size < 20) { queue.add(info); pump() }
            } }
        }
        manager.discoverServices("_bbplayer-sync._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
        try {
            delay(5000)
            failure?.let { error(it) }
            found.distinctBy { it["endpoint"] }
        } finally {
            closed = true
            try { manager.stopServiceDiscovery(listener) } catch (_: Exception) {}
            if (Build.VERSION.SDK_INT >= 34) activeResolver?.let { resolver ->
                try { manager.stopServiceResolution(resolver) } catch (_: Exception) {}
            }
        }
    }
}

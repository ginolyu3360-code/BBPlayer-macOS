package expo.modules.bbplayernative

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.Proxy
import java.net.Socket
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** An isolated, direct LAN connection. Never changes global TLS, proxy or cookie settings. */
internal object PinnedLANClient {
    private const val MAX_BODY = 16 * 1024 * 1024
    private val paths = setOf("/v1/pair", "/v1/sync", "/v1/revoke", "/v1/status")

    fun endpoint(value: String): URI {
        val uri = URI(value)
        require(uri.scheme == "https" && uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(uri.path.isNullOrEmpty() || uri.path == "/")
        require(uri.port in 1..65535)
        val host = uri.host?.removePrefix("[")?.removeSuffix("]") ?: error("LAN address missing")
        require(isLANAddress(host)) { "Only literal local network addresses are permitted" }
        return uri
    }

    fun isLANAddress(host: String): Boolean {
        // Reject DNS names before InetAddress sees them, preventing DNS rebinding and public lookups.
        val ipv4 = host.split('.')
        if (ipv4.size == 4 && ipv4.all { it.isNotEmpty() && it.all(Char::isDigit) && it.toIntOrNull() in 0..255 && it == it.toIntOrNull().toString() }) {
            val numbers = ipv4.map { it.toInt() }
            return numbers[0] == 10 || numbers[0] == 127 ||
                (numbers[0] == 172 && numbers[1] in 16..31) ||
                (numbers[0] == 192 && numbers[1] == 168) ||
                (numbers[0] == 169 && numbers[1] == 254)
        }
        if (!host.contains(':') || !Regex("[0-9a-fA-F:]+").matches(host)) return false
        return try {
            val address = InetAddress.getByName(host)
            address.isLoopbackAddress || address.isLinkLocalAddress ||
                ((address.address[0].toInt() and 0xfe) == 0xfc)
        } catch (_: Exception) { false }
    }

    fun request(endpoint: String, pin: String, path: String, bearer: String?, body: String): String {
        val origin = endpoint(endpoint)
        require(path in paths) { "Unsupported LAN request path" }
        require(Regex("[0-9a-fA-F]{64}").matches(pin)) { "Invalid pinned certificate fingerprint" }
        require(bearer == null || Regex("[A-Za-z0-9_-]{32,128}").matches(bearer)) { "Invalid pairing credential" }
        val bytes = body.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BODY) { "LAN request is too large" }
        val expected = pin.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        fun verify(certificate: X509Certificate) {
            certificate.checkValidity()
            if (!MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(certificate.encoded), expected))
                throw CertificateException("Paired device certificate changed; pair again on both devices")
        }
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = throw CertificateException("Client certificates unsupported")
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
                if (chain.size != 1) throw CertificateException("Expected paired leaf certificate")
                verify(chain[0])
            }
        }
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), null) }
        val url = URL("https", origin.host, origin.port, path)
        val connection = url.openConnection(Proxy.NO_PROXY) as HttpsURLConnection
        try {
            connection.sslSocketFactory = ModernTLSFactory(context.socketFactory)
            connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { hostname, session ->
                try {
                    require(hostname == url.host)
                    verify(session.peerCertificates[0] as X509Certificate)
                    true
                } catch (_: Exception) { false }
            }
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.useCaches = false
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer $bearer")
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            require(status == 200) { "LAN server rejected request ($status)" }
            require(connection.contentLengthLong <= MAX_BODY) { "LAN response is too large" }
            return connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= MAX_BODY) { "LAN response is too large" }
                    output.write(buffer, 0, count)
                }
                output.toString(Charsets.UTF_8.name())
            }
        } finally { connection.disconnect() }
    }
}

private class ModernTLSFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {
    private fun secure(socket: Socket): Socket = socket.apply {
        val tls = this as SSLSocket
        tls.enabledProtocols = tls.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
    }
    override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites
    override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites
    override fun createSocket(): Socket = secure(delegate.createSocket())
    override fun createSocket(socket: Socket, host: String, port: Int, autoClose: Boolean): Socket = secure(delegate.createSocket(socket, host, port, autoClose))
    override fun createSocket(host: String, port: Int): Socket = secure(delegate.createSocket(host, port))
    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = secure(delegate.createSocket(host, port, local, localPort))
    override fun createSocket(address: InetAddress, port: Int): Socket = secure(delegate.createSocket(address, port))
    override fun createSocket(address: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = secure(delegate.createSocket(address, port, local, localPort))
}

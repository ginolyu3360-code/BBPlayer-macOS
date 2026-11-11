package expo.modules.bbplayernative

import org.junit.Assert.*
import org.junit.Test

class PinnedLANClientTest {
    @Test fun acceptsOnlyLiteralPrivateAddressesAndExplicitTLSOrigin() {
        for (host in listOf("192.168.1.2", "10.0.0.1", "172.16.0.1", "172.31.255.254", "169.254.1.2", "127.0.0.1", "::1", "fc00::1", "fe80::1"))
            assertTrue(host, PinnedLANClient.isLANAddress(host))
        for (host in listOf("8.8.8.8", "172.15.1.1", "172.32.1.1", "192.169.0.1", "example.com", "192.168.1.999", "010.1.2.3", "2001:4860:4860::8888", "ff02::1", "::"))
            assertFalse(host, PinnedLANClient.isLANAddress(host))
        assertEquals(4433, PinnedLANClient.endpoint("https://192.168.1.2:4433").port)
        for (url in listOf("http://192.168.1.2:4433", "https://example.com:4433", "https://192.168.1.2", "https://user:secret@192.168.1.2:4433", "https://192.168.1.2:4433/path", "https://192.168.1.2:4433?token=secret"))
            assertThrows(IllegalArgumentException::class.java) { PinnedLANClient.endpoint(url) }
    }
    @Test fun rejectsUnexpectedPathsCredentialsAndOversizedRequestsBeforeConnecting() {
        val endpoint = "https://127.0.0.1:4433"
        val pin = "a".repeat(64)
        assertThrows(IllegalArgumentException::class.java) { PinnedLANClient.request(endpoint, pin, "/redirect", null, "{}") }
        assertThrows(IllegalArgumentException::class.java) { PinnedLANClient.request(endpoint, "invalid", "/v1/pair", null, "{}") }
        assertThrows(IllegalArgumentException::class.java) { PinnedLANClient.request(endpoint, pin, "/v1/sync", "token\r\nInjected: yes", "{}") }
        assertThrows(IllegalArgumentException::class.java) { PinnedLANClient.request(endpoint, pin, "/v1/pair", null, "x".repeat(16 * 1024 * 1024 + 1)) }
    }
}

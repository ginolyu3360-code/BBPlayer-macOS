import CryptoKit
import Foundation
import Security

public enum LANError: Error, LocalizedError {
    case identity, invalidRequest, unauthorized, unavailable
    public var errorDescription: String? {
        switch self {
        case .identity: "无法读取局域网连接身份，请检查钥匙串权限。"
        case .invalidRequest: "局域网请求无效或超过大小限制。"
        case .unauthorized: "设备尚未配对，或配对已失效。"
        case .unavailable: "局域网连接不可用，请检查两台设备的网络与权限。"
        }
    }
}

/// A dedicated TLS identity, separate from application signing and account credentials.
public struct LANIdentity: @unchecked Sendable {
    public let deviceID: String
    public let identity: SecIdentity
    public let certificate: Data
    public var fingerprint: String { SHA256.hash(data: certificate).map { String(format: "%02x", $0) }.joined() }
    private struct Stored: Codable { var deviceID: String; var privateKey: Data; var certificate: Data }
    private static let account = "lan-tls-identity-v1"

    /// Only call after the user enables local-network synchronization.
    public static func loadOrCreate(allowInteraction: Bool = true) throws -> LANIdentity {
        if let encoded = try CredentialStore.read(account, allowInteraction: allowInteraction), let data = encoded.data(using: .utf8) {
            let stored = try JSONDecoder().decode(Stored.self, from: data)
            guard UUID(uuidString: stored.deviceID) != nil,
                  let key = SecKeyCreateWithData(stored.privateKey as CFData, [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits: 256] as CFDictionary, nil) else { throw LANError.identity }
            return try assemble(key: key, certificate: stored.certificate, deviceID: stored.deviceID)
        }
        let key = try generateKey()
        let id = UUID().uuidString
        let certificate = try makeCertificate(key: key, deviceID: id)
        guard let privateKey = SecKeyCopyExternalRepresentation(key, nil) as Data? else { throw LANError.identity }
        let stored = Stored(deviceID: id, privateKey: privateKey, certificate: certificate)
        try CredentialStore.withInteractionPolicy(allowInteraction: allowInteraction) {
            try CredentialStore.write(String(decoding: JSONEncoder().encode(stored), as: UTF8.self), account: account)
        }
        return try assemble(key: key, certificate: certificate, deviceID: id)
    }
    static func ephemeral(now: Date = Date()) throws -> LANIdentity {
        let key = try generateKey(), id = UUID().uuidString
        return try assemble(key: key, certificate: makeCertificate(key: key, deviceID: id, now: now), deviceID: id)
    }
    private static func generateKey() throws -> SecKey {
        guard let key = SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256] as CFDictionary, nil) else { throw LANError.identity }
        return key
    }
    private static func assemble(key: SecKey, certificate: Data, deviceID: String) throws -> LANIdentity {
        guard let cert = SecCertificateCreateWithData(nil, certificate as CFData), let identity = SecIdentityCreate(nil, cert, key) else { throw LANError.identity }
        return LANIdentity(deviceID: deviceID, identity: identity, certificate: certificate)
    }
    private static func makeCertificate(key: SecKey, deviceID: String, now: Date = Date()) throws -> Data {
        guard let publicKey = SecKeyCopyPublicKey(key), let rawKey = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?, rawKey.count == 65 else { throw LANError.identity }
        let signatureAlgorithm = DER.sequence([DER.oid([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02])])
        let name = DER.sequence([DER.tag(0x31, DER.sequence([DER.oid([0x55,0x04,0x03]), DER.tag(0x0c, Data(("BBPlayer LAN " + deviceID).utf8))]))])
        let keyAlgorithm = DER.sequence([DER.oid([0x2a,0x86,0x48,0xce,0x3d,0x02,0x01]), DER.oid([0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07])])
        let subjectKey = DER.sequence([keyAlgorithm, DER.tag(0x03, Data([0]) + rawKey)])
        let serial = Data([0x01]) + Data(SHA256.hash(data: Data(deviceID.utf8)).prefix(15))
        func ext(_ oid: [UInt8], _ value: Data, critical: Bool = false) -> Data {
            DER.sequence([DER.oid(oid)] + (critical ? [Data([0x01,0x01,0xff])] : []) + [DER.tag(0x04, value)])
        }
        let extensions = DER.tag(0xa3, DER.sequence([
            ext([0x55,0x1d,0x13], DER.sequence([]), critical: true),
            ext([0x55,0x1d,0x0f], DER.tag(0x03, Data([7,0x80])), critical: true),
            ext([0x55,0x1d,0x25], DER.sequence([DER.oid([0x2b,0x06,0x01,0x05,0x05,0x07,0x03,0x01])])),
            ext([0x55,0x1d,0x11], DER.sequence([DER.tag(0x82, Data(("bbplayer-" + deviceID.lowercased() + ".local").utf8))]))
        ]))
        let body = DER.sequence([DER.tag(0xa0, DER.tag(0x02, Data([2]))), DER.tag(0x02, serial), signatureAlgorithm, name,
                                 DER.sequence([DER.time(now.addingTimeInterval(-86_400)), DER.time(now.addingTimeInterval(3650 * 86_400))]), name, subjectKey, extensions])
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, body as CFData, nil) as Data? else { throw LANError.identity }
        return DER.sequence([body, signatureAlgorithm, DER.tag(0x03, Data([0]) + signature)])
    }
}
private enum DER {
    static func tag(_ tag: UInt8, _ content: Data) -> Data {
        var length = content.count, bytes: [UInt8] = []
        if length < 128 { bytes = [UInt8(length)] }
        else { while length > 0 { bytes.insert(UInt8(length & 0xff), at: 0); length >>= 8 }; bytes.insert(0x80 | UInt8(bytes.count), at: 0) }
        return Data([tag] + bytes) + content
    }
    static func sequence(_ children: [Data]) -> Data { tag(0x30, children.reduce(Data(), +)) }
    static func oid(_ bytes: [UInt8]) -> Data { tag(0x06, Data(bytes)) }
    static func time(_ date: Date) -> Data {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let year = Calendar(identifier: .gregorian).component(.year, from: date), generalized = year >= 2050
        formatter.dateFormat = generalized ? "yyyyMMddHHmmss'Z'" : "yyMMddHHmmss'Z'"
        return tag(generalized ? 0x18 : 0x17, Data(formatter.string(from: date).utf8))
    }
}

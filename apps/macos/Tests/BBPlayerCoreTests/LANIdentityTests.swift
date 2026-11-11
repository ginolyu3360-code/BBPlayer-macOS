import CryptoKit
import Security
import XCTest
@testable import BBPlayerCore

final class LANIdentityTests: XCTestCase {
    func testEphemeralIdentityIsParsableSelfSignedAndBoundToItsPrivateKey() throws {
        let identity = try LANIdentity.ephemeral()
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, identity.certificate as CFData))
        XCTAssertTrue((SecCertificateCopySubjectSummary(certificate) as String? ?? "").contains(identity.deviceID))
        var privateKey: SecKey?
        XCTAssertEqual(SecIdentityCopyPrivateKey(identity.identity, &privateKey), errSecSuccess)
        let key = try XCTUnwrap(privateKey)
        let publicKey = try XCTUnwrap(SecCertificateCopyKey(certificate))
        let message = Data("TLS identity verification".utf8)
        let signature = try XCTUnwrap(SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, nil))
        XCTAssertTrue(SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, message as CFData, signature, nil))
        XCTAssertEqual(identity.fingerprint.count, 64)
        XCTAssertEqual(identity.fingerprint, SHA256.hash(data: identity.certificate).map { String(format: "%02x", $0) }.joined())
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        let evaluated = try XCTUnwrap(trust)
        SecTrustSetAnchorCertificates(evaluated, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(evaluated, true)
        XCTAssertTrue(SecTrustEvaluateWithError(evaluated, nil))
        XCTAssertNotEqual(try LANIdentity.ephemeral().fingerprint, identity.fingerprint)
    }
}

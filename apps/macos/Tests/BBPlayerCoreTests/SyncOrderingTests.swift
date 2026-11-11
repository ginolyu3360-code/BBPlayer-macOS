import Foundation
import XCTest
@testable import BBPlayerCore

final class SyncOrderingTests: XCTestCase {
    func testSharedCausalOrderFixtureDoesNotDependOnDeliveryOrReadditionTiming() throws {
        struct Case: Decodable { var sequence: Int64; var expected: [String] }
        struct Fixture: Decodable { var operations: [SyncOperation]; var cases: [Case] }
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/sync-order-v1.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
        for sample in fixture.cases {
            let history = fixture.operations.filter { $0.sequence <= sample.sequence }
            XCTAssertEqual(SyncOrdering.networkOrder(winner: history.last, history: history), sample.expected)
            XCTAssertEqual(SyncOrdering.networkOrder(winner: history.last, history: history.reversed()), sample.expected)
        }
    }
}

import XCTest
@testable import BBPlayerCore

private final class PartIdentityProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body: String
        switch request.url!.path {
        case "/x/web-interface/nav":
            body = #"{"code":0,"data":{"wbi_img":{"img_url":"https://i.example/abcdefghijklmnopqrstuvwxyz012345.png","sub_url":"https://i.example/012345abcdefghijklmnopqrstuvwxyz.png"}}}"#
        case "/x/player/pagelist":
            body = #"{"code":0,"data":[{"cid":77,"part":"First part","duration":180},{"cid":88,"part":"Second part","duration":240}]}"#
        default:
            body = #"{"code":0,"data":{"dash":{"audio":[{"baseUrl":"https://audio.example/fixture.m4a","codecs":"mp4a.40.2","bandwidth":192000}]}}}"#
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

final class DefaultPartIdentityTests: XCTestCase {
    func testDefaultResolutionRetainsLibraryUUIDAndActualHistoryCIDWithoutMergingExplicitPart() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PartIdentityProtocol.self]
        let api = BilibiliClient(session: URLSession(configuration: configuration))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try LibraryDatabase(url: root.appendingPathComponent("library.sqlite"))
        let video = Track(bvid: "fixture", title: "Saved video")
        let explicit = video.withPage(cid: 77, title: "Explicit first part", duration: 180)
        let playlist = Playlist(title: "Distinct selections")
        try database.savePlaylist(playlist, tracks: [video, explicit])
        let videoSong = try XCTUnwrap(database.songIdentity(sourceID: video.id))
        let partSong = try XCTUnwrap(database.songIdentity(sourceID: explicit.id))
        XCTAssertNotEqual(videoSong.id, partSong.id)
        let resolved = try await api.resolve(video)
        XCTAssertEqual(resolved.track.id, video.id)
        XCTAssertEqual(resolved.track.cid, 77)
        XCTAssertEqual(resolved.track.title, video.title)
        XCTAssertEqual(resolved.track.duration, 180)
        try database.checkpointHistory(id: "video-play", track: resolved.track, started: Date(), listened: 30, completed: false)
        XCTAssertEqual(try database.songIdentity(sourceID: resolved.track.id)?.id, videoSong.id)
        XCTAssertEqual(try database.historySource(eventID: "video-play")?.songID, videoSong.id)
        XCTAssertEqual(try database.historySource(eventID: "video-play")?.track.cid, 77)
        XCTAssertEqual(try database.songIdentity(sourceID: explicit.id)?.id, partSong.id)
        XCTAssertEqual(try database.tracks(playlistID: playlist.id).map(\.id), [video.id, explicit.id])
        let parts = try await api.pages(video)
        XCTAssertEqual(parts.map(\.cid), [77, 88])
        XCTAssertEqual(parts[0].id, explicit.id)
        XCTAssertNotEqual(parts[1].id, video.id)
        let explicitFirst = try await api.resolve(parts[0])
        XCTAssertNotEqual(AudioChunkRequests.cacheKey(resolved), AudioChunkRequests.cacheKey(explicitFirst))
        let resolvedPart = try await api.resolve(parts[1])
        XCTAssertEqual(resolvedPart.track.id, parts[1].id)
        XCTAssertEqual(resolvedPart.track.cid, 88)
        let retried = try await api.resolve(resolved.track)
        XCTAssertEqual(retried.track.id, video.id)
        XCTAssertEqual(retried.track.cid, 77)
        XCTAssertEqual(AudioChunkRequests.cacheKey(retried), AudioChunkRequests.cacheKey(resolved))
        let roundTrip = try JSONDecoder().decode(Track.self, from: JSONEncoder().encode(resolved.track))
        XCTAssertEqual(roundTrip.id, video.id)
        XCTAssertEqual(roundTrip.cid, 77)
    }

    @MainActor func testLegacyOfflineVideoAliasKeepsActualPartWithoutAliasingExplicitSelection() {
        let video = Track(bvid: "fixture", title: "Video")
        let first = video.withPage(cid: 77, title: "Downloaded part", duration: 180)
        let second = video.withPage(cid: 88, title: "Separate part", duration: 240)
        let aliased = NativePlaybackEngine.offlinePlaybackTrack(requested: video, metadata: first)
        XCTAssertEqual(aliased.id, video.id)
        XCTAssertEqual(aliased.cid, 77)
        var previouslyResolvedVideo = video; previouslyResolvedVideo.cid = 88
        let oldDownload = NativePlaybackEngine.offlinePlaybackTrack(requested: previouslyResolvedVideo, metadata: first)
        XCTAssertEqual(oldDownload.id, video.id)
        XCTAssertEqual(oldDownload.cid, 77) // History describes the downloaded audio actually used.
        XCTAssertEqual(NativePlaybackEngine.offlinePlaybackTrack(requested: first, metadata: first), first)
        XCTAssertEqual(NativePlaybackEngine.offlinePlaybackTrack(requested: second, metadata: second), second)
        XCTAssertEqual(NativePlaybackEngine.offlinePlaybackTrack(requested: video, metadata: nil), video)
        let differentVideo = Track(bvid: "different", cid: 77, title: "Different video")
        XCTAssertEqual(NativePlaybackEngine.offlinePlaybackTrack(requested: video, metadata: differentVideo).id, differentVideo.id)
    }
}

import Foundation

struct LANHTTPRequest {
    var path: String
    var bearer: String?
    var body: Data
}
/// Single bounded HTTP/1.1 POST, with no chunking, redirects, pipelining or ambiguous lengths.
struct LANHTTPParser {
    private var bytes = Data()
    private var headerLength: Int?
    private var contentLength: Int?
    private var path = ""
    private var bearer: String?
    mutating func append(_ chunk: Data) throws -> LANHTTPRequest? {
        guard bytes.count + chunk.count <= 16 * 1024 * 1024 + 8192 else { throw LANError.invalidRequest }
        bytes.append(chunk)
        if headerLength == nil {
            if let end = bytes.range(of: Data([13,10,13,10])) {
                guard end.upperBound <= 8192, let header = String(data: bytes[..<end.lowerBound], encoding: .ascii) else { throw LANError.invalidRequest }
                let lines = header.components(separatedBy: "\r\n")
                let request = lines[0].components(separatedBy: " ")
                guard request.count == 3, request[0] == "POST", request[2] == "HTTP/1.1",
                      ["/v1/pair", "/v1/sync", "/v1/revoke", "/v1/status"].contains(request[1]) else { throw LANError.invalidRequest }
                path = request[1]
                var fields: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw LANError.invalidRequest }
                    let key = String(line[..<colon]).lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    guard !key.isEmpty, fields[key] == nil else { throw LANError.invalidRequest }
                    fields[key] = value
                }
                guard fields["transfer-encoding"] == nil, let length = fields["content-length"], !length.isEmpty,
                      length.allSatisfy({ $0.isASCII && $0.isNumber }), let count = Int(length), count <= 16 * 1024 * 1024,
                      fields["content-type"]?.lowercased().split(separator: ";").first == "application/json" else { throw LANError.invalidRequest }
                if let authorization = fields["authorization"] {
                    guard authorization.hasPrefix("Bearer "), authorization.utf8.count <= 135 else { throw LANError.unauthorized }
                    bearer = String(authorization.dropFirst(7))
                }
                headerLength = end.upperBound; contentLength = count
            } else {
                guard bytes.count < 8192 else { throw LANError.invalidRequest }
                return nil
            }
        }
        guard let headerLength, let contentLength else { return nil }
        guard bytes.count <= headerLength + contentLength else { throw LANError.invalidRequest }
        if bytes.count == headerLength + contentLength { return LANHTTPRequest(path: path, bearer: bearer, body: Data(bytes.dropFirst(headerLength))) }
        return nil
    }
    static func response(_ body: Data, status: Int = 200) -> Data {
        Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Rejected")\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8) + body
    }
}

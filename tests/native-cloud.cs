using System;
using System.IO;
using System.Net;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class NativeCloudTests {
    private static int checks;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    public static int Main(string[] args) {
        Check(CloudFailure.UnexpectedResponse(302).Code == "CLOUD_ACCESS", "login redirect must be access failure");
        Check(CloudFailure.UnexpectedResponse(403).Status == 403, "gateway denial must remain forbidden");
        Check(CloudFailure.UnexpectedResponse(200).Status == 502, "HTML success must not be cloud success");
        Check(CloudFailure.UnexpectedResponse(503).Status == 503, "transient failure must remain retryable");
        Check(CloudFailure.FromException(new TaskCanceledException()).Code == "CLOUD_TIMEOUT", "cancelled deadline");
        Check(CloudFailure.FromException(new Exception("secret", new WebException("secret", WebExceptionStatus.NameResolutionFailure))).Code == "CLOUD_DNS", "nested DNS error");
        Check(CloudFailure.FromException(new WebException("secret", WebExceptionStatus.TrustFailure)).Code == "CLOUD_TLS", "TLS certificate error");
        string json = CloudFailure.FromException(new Exception("secret-token-cookie")).Json();
        Check(!json.Contains("secret-token-cookie"), "exception details must not leak to UI");
        Check(new JavaScriptSerializer().DeserializeObject(json) != null, "valid JSON error response");
        string directory = Path.GetFullPath(args[0]);
        CloudDiagnostics.Record(directory, "GET", "/api/projects/private-project-id?token=secret", 503, "CLOUD_NETWORK");
        string log = File.ReadAllText(Path.Combine(directory, "connection.log"));
        Check(!log.Contains("private-project-id") && !log.Contains("secret") && log.Contains("/api/projects/*"), "diagnostic redaction");
        Console.WriteLine("Native cloud: " + checks + " checks passed."); return 0;
    }
}

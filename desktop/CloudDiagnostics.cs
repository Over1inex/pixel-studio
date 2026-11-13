using System;
using System.IO;
using System.Net;
using System.Web.Script.Serialization;

internal sealed class CloudFailure {
    internal readonly int Status;
    internal readonly string Code, Message;
    internal CloudFailure(int status, string code, string message) { Status = status; Code = code; Message = message; }
    internal string Json() { return new JavaScriptSerializer().Serialize(new { error = Message, code = Code }); }
    internal static CloudFailure UnexpectedResponse(int status) {
        if ((status >= 300 && status < 400) || status == 401 || status == 403)
            return new CloudFailure(403, "CLOUD_ACCESS", "Сервер отклонил подключение или запросил дополнительный вход. Проверьте версию приложения и настройку облачного сервиса.");
        return new CloudFailure(status >= 400 ? status : 502, "CLOUD_RESPONSE", "Вместо данных облака получена страница сервера. Возможен временный сбой сервиса или сетевого посредника. Повторим подключение автоматически.");
    }
    internal static CloudFailure FromException(Exception error) {
        for (Exception current = error; current != null; current = current.InnerException) {
            if (current is OperationCanceledException)
                return new CloudFailure(504, "CLOUD_TIMEOUT", "Облако не ответило вовремя. Проверьте доступ к сервису; подключение повторится автоматически.");
            var network = current as WebException;
            if (network == null) continue;
            switch (network.Status) {
                case WebExceptionStatus.NameResolutionFailure:
                case WebExceptionStatus.ProxyNameResolutionFailure:
                    return new CloudFailure(503, "CLOUD_DNS", "Windows не смогла найти адрес облака. Проверьте DNS и соединение VPN, если используете его.");
                case WebExceptionStatus.TrustFailure:
                case WebExceptionStatus.SecureChannelFailure:
                    return new CloudFailure(503, "CLOUD_TLS", "Не удалось установить защищённое соединение. Проверьте дату Windows и настройки HTTPS в вашей сети.");
                case WebExceptionStatus.Timeout:
                    return new CloudFailure(504, "CLOUD_TIMEOUT", "Облако не ответило вовремя. Повторим подключение автоматически.");
            }
        }
        return new CloudFailure(503, "CLOUD_NETWORK", "Windows не смогла подключиться к облаку. Проверьте доступ к сервису и VPN, если используете его. Подключение повторится автоматически.");
    }
}

internal static class CloudDiagnostics {
    private static readonly object Gate = new object();
    // Omit URLs, query strings, headers, cookies, payloads and exception messages.
    internal static void Record(string directory, string method, string path, int status, string code) {
        try {
            string route = path == "/api/me" || path == "/api/auth/config" || path == "/api/auth/logout" ? path :
                path.StartsWith("/api/projects", StringComparison.Ordinal) ? "/api/projects/*" : "/api/other";
            string line = new JavaScriptSerializer().Serialize(new { utc = DateTime.UtcNow.ToString("o"), method, route, status, code });
            lock (Gate) {
                Directory.CreateDirectory(directory);
                string file = Path.Combine(directory, "connection.log");
                if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024) {
                    string previous = file + ".previous";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(file, previous);
                }
                File.AppendAllText(file, line + Environment.NewLine);
            }
        } catch { /* Diagnostic failure must never interrupt editing or saving. */ }
    }
}

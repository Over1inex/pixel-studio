using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class DesktopUpdater {
    internal const string ReleaseApi = "https://api.github.com/repos/Over1inex/pixel-studio/releases/latest";
    private static readonly string[] PackageNames = { "Pixel Studio.exe", "Удалить Pixel Studio.exe", "Начните здесь.txt", "GIF-LICENSES.txt", "LICENSE-MIT.txt", "THIRD-PARTY-NOTICES.txt", "WebView2-LICENSE.txt", "WebView2-NOTICE.txt" };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
    private readonly HttpClient client;
    private readonly string directory, executable;
    private string phase = "idle", message = "Проверка обновлений ещё не выполнялась.", stagedDirectory;
    private int progress;
    private Release release;
    private List<UpdateFile> stagedFiles;
    internal sealed class Release { public string Version, Url, Hash; public long Size; }
    internal sealed class UpdateFile { public string name, hash; }
    internal DesktopUpdater(HttpClient testClient = null, string testDirectory = null, string testExecutable = null) {
        directory = testDirectory ?? Path.Combine(DesktopApp.DataDirectory, "Updates");
        executable = testExecutable ?? Assembly.GetExecutingAssembly().Location;
        client = testClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate }) { Timeout = TimeSpan.FromSeconds(90) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("PixelStudio/" + DesktopApp.Version);
        client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/vnd.github+json");
    }
    internal string StatusJson() { return json.Serialize(new { supported = true, currentVersion = DesktopApp.Version, availableVersion = release == null ? null : release.Version, phase, message, progress }); }
    internal static bool IsDownloadHost(Uri uri) { return uri.Scheme == "https" && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) && (uri.Host == "github.com" || uri.Host == "release-assets.githubusercontent.com" || uri.Host == "objects.githubusercontent.com"); }
    private async Task<HttpResponseMessage> Send(Uri uri, bool download, CancellationToken token) {
        for (int redirect = 0; redirect < 5; redirect++) {
            if (download ? !IsDownloadHost(uri) : uri.AbsoluteUri != ReleaseApi) throw new InvalidDataException("Недопустимый адрес обновления.");
            using (var request = new HttpRequestMessage(HttpMethod.Get, uri)) {
                request.Headers.ConnectionClose = true;
                var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) {
                    var location = response.Headers.Location; response.Dispose();
                    if (!download || location == null) throw new InvalidDataException("Сервер обновлений вернул перенаправление.");
                    uri = location.IsAbsoluteUri ? location : new Uri(uri, location); continue;
                }
                if (!response.IsSuccessStatusCode) { int status = (int)response.StatusCode; response.Dispose(); throw new IOException(status == 403 || status == 429 ? "GitHub временно ограничил проверку. Попробуйте позднее." : "GitHub не ответил на запрос обновления."); }
                return response;
            }
        }
        throw new InvalidDataException("Слишком много перенаправлений обновления.");
    }
    internal static Release ReadRelease(Dictionary<string, object> data, Version current) {
        object value;
        if (!data.TryGetValue("tag_name", out value) || !(value is string) || !Regex.IsMatch((string)value, @"\Av\d{1,4}\.\d{1,4}\.\d{1,4}\z")) throw new InvalidDataException("GitHub вернул неверную версию.");
        string tag = (string)value, version = tag.Substring(1);
        if (data.TryGetValue("draft", out value) && Equals(value, true) || data.TryGetValue("prerelease", out value) && Equals(value, true)) return null;
        if (new Version(version) <= current) return null;
        var assets = data.ContainsKey("assets") ? data["assets"] as System.Collections.IEnumerable : null;
        if (assets == null) throw new InvalidDataException("У обновления нет файлов.");
        string name = "Pixel-Studio-" + version + "-Windows.zip";
        foreach (object item in assets) {
            var asset = item as Dictionary<string, object>;
            if (asset == null || !asset.ContainsKey("name") || !Equals(asset["name"], name)) continue;
            string url = asset.ContainsKey("browser_download_url") ? asset["browser_download_url"] as string : null;
            string hash = asset.ContainsKey("digest") ? asset["digest"] as string : null;
            long size; if (!asset.ContainsKey("size") || !long.TryParse(asset["size"].ToString(), out size) || size < 1 || size > 30 * 1024 * 1024) throw new InvalidDataException("Неверный размер обновления.");
            if (url != "https://github.com/Over1inex/pixel-studio/releases/download/" + tag + "/" + name || hash == null || !Regex.IsMatch(hash, @"\Asha256:[a-f0-9]{64}\z")) throw new InvalidDataException("Не удалось проверить происхождение обновления.");
            return new Release { Version = version, Url = url, Hash = hash.Substring(7), Size = size };
        }
        throw new InvalidDataException("В релизе нет Windows-архива с проверочной суммой.");
    }
    private static async Task<byte[]> Read(Stream source, int limit, CancellationToken token) {
        using (var output = new MemoryStream())
        using (token.Register(delegate { source.Dispose(); })) {
            var buffer = new byte[65536]; int count;
            while ((count = await source.ReadAsync(buffer, 0, buffer.Length, token)) > 0) { if (output.Length + count > limit) throw new InvalidDataException("Ответ обновления слишком большой."); output.Write(buffer, 0, count); }
            return output.ToArray();
        }
    }
    internal async Task CheckAsync() {
        if (!await gate.WaitAsync(0)) return;
        try {
            if (phase == "ready") return;
            phase = "checking"; message = "Проверяем новые версии на GitHub…";
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30)))
            using (var response = await Send(new Uri(ReleaseApi), false, deadline.Token))
            using (var stream = await response.Content.ReadAsStreamAsync()) {
                var data = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(await Read(stream, 1024 * 1024, deadline.Token)));
                release = ReadRelease(data, new Version(DesktopApp.Version));
            }
            phase = release == null ? "idle" : "available";
            message = release == null ? "Установлена актуальная версия " + DesktopApp.Version + "." : "Доступна версия " + release.Version + ".";
        } catch (Exception error) { phase = "error"; message = Friendly(error); }
        finally { gate.Release(); }
    }
    private static string Friendly(Exception error) { return error is InvalidDataException || error is IOException ? error.Message : "Не удалось связаться с GitHub. Проверьте подключение и повторите попытку."; }
    internal static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    internal async Task DownloadAsync() {
        if (!await gate.WaitAsync(0)) return;
        try {
            if (release == null) throw new InvalidDataException("Сначала проверьте доступность обновления.");
            if (phase == "ready") return;
            phase = "downloading"; progress = 0; message = "Загружаем и проверяем обновление…";
            byte[] package;
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(90)))
            using (var response = await Send(new Uri(release.Url), true, deadline.Token))
            using (var stream = await response.Content.ReadAsStreamAsync()) package = await Read(stream, 30 * 1024 * 1024, deadline.Token);
            if (package.LongLength != release.Size || Hash(package) != release.Hash) throw new InvalidDataException("Проверочная сумма обновления не совпала. Установка отменена.");
            progress = 70;
            string stage = Path.Combine(directory, release.Version + "-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
            var files = new List<UpdateFile>(); long total = 0;
            using (var archive = new ZipArchive(new MemoryStream(package), ZipArchiveMode.Read)) {
                if (archive.Entries.Count > 40) throw new InvalidDataException("Некорректный архив обновления.");
                foreach (var entry in archive.Entries) {
                    if (entry.FullName == "Pixel Studio/") continue;
                    string name = entry.FullName.StartsWith("Pixel Studio/", StringComparison.Ordinal) ? entry.FullName.Substring(13) : "";
                    if (Array.IndexOf(PackageNames, name) < 0 || files.Exists(file => file.name == name) || entry.Length > 32 * 1024 * 1024 || (total += entry.Length) > 64 * 1024 * 1024) throw new InvalidDataException("Архив содержит недопустимые файлы.");
                    byte[] bytes; using (var stream = entry.Open()) using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15))) bytes = await Read(stream, 32 * 1024 * 1024, deadline.Token);
                    File.WriteAllBytes(Path.Combine(stage, name), bytes); files.Add(new UpdateFile { name = name, hash = Hash(bytes) });
                }
            }
            foreach (string name in new[] { "Pixel Studio.exe", "Удалить Pixel Studio.exe" }) {
                if (!files.Exists(file => file.name == name)) throw new InvalidDataException("В обновлении отсутствует приложение или программа удаления.");
                var info = FileVersionInfo.GetVersionInfo(Path.Combine(stage, name));
                if (info.FileVersion != release.Version + ".0" || info.FileDescription != (name == "Pixel Studio.exe" ? "Pixel Studio" : "Удаление Pixel Studio")) throw new InvalidDataException("Версия исполняемого файла не совпала с релизом.");
            }
            stagedDirectory = stage; stagedFiles = files; progress = 100; phase = "ready";
            message = "Версия " + release.Version + " проверена. Она установится после закрытия всех окон этой копии редактора.";
        } catch (Exception error) { phase = "error"; message = Friendly(error); }
        finally { gate.Release(); }
    }
    internal void Cancel() { if (phase == "ready") { phase = "available"; stagedDirectory = null; stagedFiles = null; message = "Установка отложена. Текущая версия продолжает работать."; } }
    internal void InstallOnExit() {
        if (phase != "ready" || stagedDirectory == null || stagedFiles == null) return;
        string script;
        using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("PixelStudio.Update.ps1"))
        using (var reader = new StreamReader(resource, Encoding.UTF8)) script = reader.ReadToEnd();
        var plan = new { root = Path.GetDirectoryName(executable), executable = Path.GetFileName(executable), stage = stagedDirectory, version = release.Version, files = stagedFiles, parentId = Process.GetCurrentProcess().Id };
        string data = Convert.ToBase64String(Encoding.UTF8.GetBytes(json.Serialize(plan)));
        script = "$taskPlan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + data + "'))|ConvertFrom-Json\n" + script;
        Process.Start(new ProcessStartInfo {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)),
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System), UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
        });
    }
}

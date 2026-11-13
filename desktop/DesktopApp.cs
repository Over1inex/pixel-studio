using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class DesktopApp {
    internal const string Version = "0.2.0";
    internal const string SiteUrl = "https://pixel-studio-nov12-26.recentlens.chatgpt.site";
    internal const string LocalOrigin = "https://pixel-studio.local";
    internal static readonly string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PixelStudio");
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    // This per-user credential is provisioned separately; it is never an EXE
    // resource, browser cookie, JavaScript value, or part of the source archive.
    internal static bool AddServiceAccess(HttpRequestMessage request, Uri backend) {
        Uri configured = new Uri(SiteUrl);
        string expected = configured.GetLeftPart(UriPartial.Authority);
        if (backend.Scheme != "https" || backend.GetLeftPart(UriPartial.Authority) != expected || request.RequestUri == null || request.RequestUri.Scheme != "https" || request.RequestUri.GetLeftPart(UriPartial.Authority) != expected) return false;
        string path = Path.Combine(DataDirectory, "service-access.bin");
        try {
            if (!File.Exists(path) || new FileInfo(path).Length > 131072) return false;
            byte[] plaintext = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser);
            try {
                string token = Encoding.UTF8.GetString(plaintext).Trim();
                if (token.Length < 1 || token.Length > 16384 || token.IndexOfAny(new char[] { '\r', '\n' }) >= 0) return false;
                return request.Headers.TryAddWithoutValidation("OAI-Sites-Authorization", "Bearer " + token);
            } finally { Array.Clear(plaintext, 0, plaintext.Length); }
        } catch { return false; }
    }
    internal static int Run(string[] args) {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        string runtime = Path.Combine(DataDirectory, "Runtime", "1.0.4314.35");
        Directory.CreateDirectory(runtime);
        string loader = Path.Combine(runtime, "WebView2Loader.dll");
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("WebView2Loader.dll")) {
            if (source == null) throw new InvalidDataException("В приложении отсутствует WebView2Loader.");
            if (!File.Exists(loader) || new FileInfo(loader).Length != source.Length) {
                using (var output = File.Create(loader)) source.CopyTo(output);
            }
        }
        CoreWebView2Environment.SetLoaderDllFolderPath(runtime);
        string uiDirectory = ExtractEmbeddedUI();
        if (Array.IndexOf(args, "--self-test") >= 0) {
            string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (string.IsNullOrEmpty(version)) return 2;
            if (!File.Exists(Path.Combine(uiDirectory, "index.html"))) return 3;
            return NativeSession.SelfTest() ? 0 : 4;
        }
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool local = Array.IndexOf(args, "--local") >= 0;
        Application.Run(new StudioWindow(local ? "http://127.0.0.1:5173/" : SiteUrl, local, uiDirectory));
        return 0;
    }

    private static string ExtractEmbeddedUI() {
        byte[] bytes;
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("PixelStudio.UI.zip")) {
            if (resource == null) throw new InvalidDataException("В приложении отсутствуют файлы редактора.");
            using (var buffer = new MemoryStream()) { resource.CopyTo(buffer); bytes = buffer.ToArray(); }
        }
        string hash;
        using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        string destination = Path.Combine(DataDirectory, "UI", hash);
        string complete = Path.Combine(destination, ".complete");
        if (File.Exists(complete) && File.Exists(Path.Combine(destination, "index.html"))) return destination;
        using (var mutex = new Mutex(false, "Local\\PixelStudio.UI.Extract")) {
            bool acquired = false;
            try {
                try { acquired = mutex.WaitOne(TimeSpan.FromSeconds(30)); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new IOException("Подготовка редактора уже выполняется. Попробуйте открыть приложение ещё раз.");
                if (File.Exists(complete) && File.Exists(Path.Combine(destination, "index.html"))) return destination;
                Directory.CreateDirectory(destination);
                string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                long total = 0;
                using (var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read)) {
                    if (zip.Entries.Count > 2000) throw new InvalidDataException("Слишком много файлов редактора.");
                    foreach (var entry in zip.Entries) {
                        total += entry.Length;
                        if (total > 128 * 1024 * 1024) throw new InvalidDataException("Некорректный размер файлов редактора.");
                        string target = Path.GetFullPath(Path.Combine(destination, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Некорректный путь файла редактора.");
                        if (string.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (var source = entry.Open()) using (var output = File.Create(target)) source.CopyTo(output);
                    }
                }
                if (!File.Exists(Path.Combine(destination, "index.html"))) throw new InvalidDataException("Не найдена стартовая страница редактора.");
                File.WriteAllText(complete, hash, Encoding.ASCII);
            } finally { if (acquired) mutex.ReleaseMutex(); }
        }
        return destination;
    }
}

internal static class NativeSession {
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PixelStudio.Session.v1");
    private static string SessionPath(bool local) { return Path.Combine(DesktopApp.DataDirectory, local ? "session.local.bin" : "session.bin"); }
    private static bool ValidToken(string token) { return token != null && Regex.IsMatch(token, "\\A[a-f0-9]{64}\\z"); }
    internal static Cookie Load(Uri origin, bool local) {
        string path = SessionPath(local);
        if (!File.Exists(path)) return null;
        try {
            if (new FileInfo(path).Length > 16384) throw new InvalidDataException();
            byte[] plain = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
            string[] parts = Encoding.UTF8.GetString(plain).Split('\n');
            long ticks;
            if (parts.Length != 3 || parts[0] != origin.GetLeftPart(UriPartial.Authority) || !long.TryParse(parts[1], out ticks) || !ValidToken(parts[2])) throw new InvalidDataException();
            var expiration = new DateTime(ticks, DateTimeKind.Utc);
            if (expiration <= DateTime.UtcNow) { Clear(local); return null; }
            return new Cookie("pixel_session", parts[2], "/", origin.Host) { HttpOnly = true, Secure = origin.Scheme == "https", Expires = expiration };
        } catch { Clear(local); return null; }
    }
    internal static void Save(Cookie cookie, Uri origin, bool local) {
        if (!ValidToken(cookie.Value)) throw new InvalidDataException("Сервер вернул некорректный сеанс входа.");
        DateTime expiration = cookie.Expires == DateTime.MinValue ? DateTime.UtcNow.AddDays(30) : cookie.Expires.ToUniversalTime();
        string value = origin.GetLeftPart(UriPartial.Authority) + "\n" + expiration.Ticks + "\n" + cookie.Value;
        byte[] encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), Entropy, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(DesktopApp.DataDirectory);
        string path = SessionPath(local), temporary = path + ".tmp";
        File.WriteAllBytes(temporary, encrypted);
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }
    internal static void Clear(bool local) { try { string path = SessionPath(local); if (File.Exists(path)) File.Delete(path); } catch { } }
    internal static bool SelfTest() {
        byte[] input = Encoding.UTF8.GetBytes("PixelStudio DPAPI self-test");
        byte[] protectedValue = ProtectedData.Protect(input, Entropy, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(protectedValue, Entropy, DataProtectionScope.CurrentUser)) == Encoding.UTF8.GetString(input);
    }
}

internal sealed class StudioWindow : Form {
    private readonly WebView2 web = new WebView2();
    private readonly Panel loading = new Panel();
    private readonly Label status = new Label();
    private readonly Button retry = new Button();
    private readonly Uri backend;
    private readonly bool local;
    private readonly string uiDirectory;
    private readonly CookieContainer cookies = new CookieContainer();
    private readonly HttpClient client;
    private bool closeApproved;
    private bool checkingClose;
    private bool signingIn;
    private bool initializing;

    internal StudioWindow(string address, bool local, string uiDirectory) {
        this.backend = new Uri(new Uri(address).GetLeftPart(UriPartial.Authority));
        this.local = local; this.uiDirectory = uiDirectory;
        if (!(backend.Scheme == "https" || (local && backend.Scheme == "http" && backend.IsLoopback))) throw new InvalidOperationException("Некорректный адрес API.");
        var handler = new HttpClientHandler { CookieContainer = cookies, AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
        client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("PixelStudio/" + DesktopApp.Version);
        Cookie session = NativeSession.Load(backend, local);
        if (session != null) cookies.Add(backend, session);
        Text = "Pixel Studio " + DesktopApp.Version + (local ? " — локальный API" : "");
        Width = 1440; Height = 960; MinimumSize = new Size(900, 640);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(22, 24, 27);
        Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        web.Dock = DockStyle.Fill; web.DefaultBackgroundColor = BackColor; Controls.Add(web);
        loading.Dock = DockStyle.Fill; loading.BackColor = BackColor;
        status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleCenter;
        status.ForeColor = Color.FromArgb(194, 245, 117); status.Font = new Font("Segoe UI", 16);
        status.Text = "PIXEL STUDIO\n\nОткрываем ваше пространство…";
        retry.Text = "Повторить запуск"; retry.Dock = DockStyle.Bottom; retry.Height = 48;
        retry.BackColor = Color.FromArgb(194, 245, 117); retry.FlatStyle = FlatStyle.Flat; retry.Visible = false;
        retry.Click += delegate { retry.Visible = false; status.Text = "Открываем редактор…"; if (web.CoreWebView2 != null) web.CoreWebView2.Navigate(DesktopApp.LocalOrigin + "/index.html"); else Initialize(); };
        loading.Controls.Add(status); loading.Controls.Add(retry); Controls.Add(loading); loading.BringToFront();
        Shown += delegate { Initialize(); };
        FormClosing += CheckUnsaved;
        FormClosed += delegate { client.Dispose(); web.Dispose(); };
    }
    private async void CheckUnsaved(object sender, FormClosingEventArgs ev) {
        if (closeApproved || web.CoreWebView2 == null) return;
        ev.Cancel = true;
        if (checkingClose) return;
        checkingClose = true;
        try {
            string dirty = await web.CoreWebView2.ExecuteScriptAsync("Boolean(window.__pixelStudioDirty)");
            if (dirty == "true" && MessageBox.Show("Есть несохранённые изменения. Закрыть Pixel Studio?", "Pixel Studio", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            closeApproved = true; Close();
        } catch { closeApproved = true; Close(); }
        finally { checkingClose = false; }
    }
    private static bool IsLocalUI(Uri target) {
        return target.Scheme == "https" && target.Host == "pixel-studio.local" && target.IsDefaultPort;
    }
    private async void SignIn() {
        if (signingIn) return;
        signingIn = true;
        try {
            Cookie session = await GoogleSignIn.Login(backend.AbsoluteUri);
            if (IsDisposed) return;
            var persistent = new Cookie("pixel_session", session.Value, "/", backend.Host) { HttpOnly = true, Secure = backend.Scheme == "https", Expires = session.Expires == DateTime.MinValue ? DateTime.UtcNow.AddDays(30) : session.Expires };
            NativeSession.Save(persistent, backend, local);
            cookies.Add(backend, persistent);
            await web.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new Event('pixel-auth-changed'))");
            Activate();
        } catch (Exception ex) {
            if (!IsDisposed) MessageBox.Show(this, ex is HttpRequestException || ex is TaskCanceledException ? "Не удалось подключиться к входу Google. Проверьте интернет. Редактор продолжает работать без входа." : ex.Message, "Вход через Google", MessageBoxButtons.OK, MessageBoxIcon.Information);
        } finally { signingIn = false; }
    }
    private static async Task<byte[]> ReadLimited(Stream stream, int maximum, CancellationToken cancellation = default(CancellationToken)) {
        using (var buffer = new MemoryStream()) {
            byte[] chunk = new byte[81920];
            int count;
            while ((count = await stream.ReadAsync(chunk, 0, chunk.Length, cancellation)) > 0) {
                if (buffer.Length + count > maximum) throw new InvalidDataException("Размер данных превышает допустимый.");
                buffer.Write(chunk, 0, count);
            }
            return buffer.ToArray();
        }
    }
    private void JsonResponse(CoreWebView2WebResourceRequestedEventArgs ev, int code, string reason, string json) {
        ev.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(json)), code, reason, "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n");
    }
    private void LocalResource(object sender, CoreWebView2WebResourceRequestedEventArgs ev) {
        Uri source;
        if (!Uri.TryCreate(ev.Request.Uri, UriKind.Absolute, out source) || !IsLocalUI(source)) {
            JsonResponse(ev, 403, "Forbidden", "{}"); return;
        }
        if (source.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal)) { ProxyApi(sender, ev); return; }
        if (ev.Request.Method != "GET" && ev.Request.Method != "HEAD") { JsonResponse(ev, 405, "Method Not Allowed", "{}"); return; }
        try {
            string root = Path.GetFullPath(uiDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string relative = Uri.UnescapeDataString(source.AbsolutePath).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            string path = Path.GetFullPath(Path.Combine(root, relative));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(path)) { JsonResponse(ev, 404, "Not Found", "{}"); return; }
            string type;
            switch (Path.GetExtension(path).ToLowerInvariant()) {
                case ".html": type = "text/html; charset=utf-8"; break;
                case ".js": type = "text/javascript; charset=utf-8"; break;
                case ".css": type = "text/css; charset=utf-8"; break;
                case ".svg": type = "image/svg+xml"; break;
                case ".png": type = "image/png"; break;
                case ".woff2": type = "font/woff2"; break;
                default: JsonResponse(ev, 404, "Not Found", "{}"); return;
            }
            byte[] body = ev.Request.Method == "HEAD" ? new byte[0] : File.ReadAllBytes(path);
            ev.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(body), 200, "OK", "Content-Type: " + type + "\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n");
        } catch { JsonResponse(ev, 404, "Not Found", "{}"); }
    }
    private async void ProxyApi(object sender, CoreWebView2WebResourceRequestedEventArgs ev) {
        var deferral = ev.GetDeferral();
        string route = "/api/other", method = ev.Request.Method.ToUpperInvariant();
        try {
            Uri source;
            if (!Uri.TryCreate(ev.Request.Uri, UriKind.Absolute, out source) || !IsLocalUI(source) || !source.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal)) {
                JsonResponse(ev, 403, "Forbidden", "{\"error\":\"Недопустимый запрос.\"}"); return;
            }
            Uri target = new Uri(backend, source.PathAndQuery);
            if (target.GetLeftPart(UriPartial.Authority) != backend.GetLeftPart(UriPartial.Authority) || !target.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal)) {
                JsonResponse(ev, 403, "Forbidden", "{\"error\":\"Недопустимый адрес API.\"}"); return;
            }
            route = source.AbsolutePath;
            if (method != "GET" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" && method != "HEAD") {
                JsonResponse(ev, 405, "Method Not Allowed", "{\"error\":\"Этот метод не поддерживается.\"}"); return;
            }
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25)))
            using (var request = new HttpRequestMessage(new HttpMethod(method), target)) {
                if (!DesktopApp.AddServiceAccess(request, backend) && !local) {
                    var missing = new CloudFailure(403, "CLOUD_ACCESS_MISSING", "На этом ПК отсутствует или не читается настройка доступа к закрытому облаку. Нужно восстановить служебный доступ; повторный вход Google это не исправит.");
                    CloudDiagnostics.Record(DesktopApp.DataDirectory, method, route, missing.Status, missing.Code);
                    JsonResponse(ev, missing.Status, "Forbidden", missing.Json()); return;
                }
                // Do not retain a connection from the previous network/VPN route.
                request.Headers.ConnectionClose = true;
                request.Headers.TryAddWithoutValidation("Origin", backend.GetLeftPart(UriPartial.Authority));
                request.Headers.TryAddWithoutValidation("Accept", "application/json");
                if (ev.Request.Content != null && method != "GET" && method != "HEAD") {
                    byte[] body = await ReadLimited(ev.Request.Content, 16 * 1024 * 1024, deadline.Token);
                    request.Content = new ByteArrayContent(body);
                    string type = ev.Request.Headers.Contains("Content-Type") ? ev.Request.Headers.GetHeader("Content-Type") : "application/json";
                    request.Content.Headers.TryAddWithoutValidation("Content-Type", type);
                }
                using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token)) {
                    string type = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.ToString();
                    if (((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) || !type.StartsWith("application/json", StringComparison.OrdinalIgnoreCase)) {
                        var failure = CloudFailure.UnexpectedResponse((int)response.StatusCode);
                        CloudDiagnostics.Record(DesktopApp.DataDirectory, method, route, (int)response.StatusCode, failure.Code);
                        JsonResponse(ev, failure.Status, "Cloud Response Error", failure.Json()); return;
                    }
                    byte[] body;
                    using (Stream content = await response.Content.ReadAsStreamAsync())
                    using (deadline.Token.Register(delegate { content.Dispose(); })) {
                        try { body = await ReadLimited(content, 32 * 1024 * 1024, deadline.Token); }
                        catch { deadline.Token.ThrowIfCancellationRequested(); throw; }
                    }
                    CloudDiagnostics.Record(DesktopApp.DataDirectory, method, route, (int)response.StatusCode, response.IsSuccessStatusCode ? "OK" : "HTTP_ERROR");
                    if (response.IsSuccessStatusCode && method == "POST" && source.AbsolutePath == "/api/auth/logout") {
                        NativeSession.Clear(local);
                        cookies.Add(backend, new Cookie("pixel_session", "", "/", backend.Host) { Expires = DateTime.UtcNow.AddDays(-1) });
                    }
                    ev.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(body), (int)response.StatusCode, response.ReasonPhrase ?? "Response", "Content-Type: " + type + "\r\nCache-Control: no-store\r\n");
                }
            }
        } catch (InvalidDataException) {
            if (!IsDisposed) JsonResponse(ev, 413, "Payload Too Large", "{\"error\":\"Проект слишком большой для облачного сервиса. Сохраните его на компьютере.\"}");
        } catch (Exception error) {
            var failure = CloudFailure.FromException(error);
            CloudDiagnostics.Record(DesktopApp.DataDirectory, method, route, failure.Status, failure.Code);
            if (!IsDisposed) JsonResponse(ev, failure.Status, "Cloud Connection Error", failure.Json());
        } finally { try { deferral.Complete(); } catch { } }
    }
    private async void Initialize() {
        if (initializing) return;
        initializing = true;
        try {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DesktopApp.DataDirectory, local ? "LocalProfile" : "Profile"));
            await web.EnsureCoreWebView2Async(environment);
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.IsWebMessageEnabled = false;
            web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            // Virtual-host mappings bypass WebResourceRequested, including /api.
            // Serve bundled assets and API through the same intercepted origin.
            web.CoreWebView2.AddWebResourceRequestedFilter(DesktopApp.LocalOrigin + "/*", CoreWebView2WebResourceContext.All);
            web.CoreWebView2.WebResourceRequested += LocalResource;
            web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs ev) {
                Uri target;
                if (!Uri.TryCreate(ev.Uri, UriKind.Absolute, out target) || !IsLocalUI(target)) { ev.Cancel = true; return; }
                if (target.AbsolutePath == "/auth/desktop-google") { ev.Cancel = true; SignIn(); }
            };
            web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs ev) {
                ev.Handled = true;
                Uri target;
                if (Uri.TryCreate(ev.Uri, UriKind.Absolute, out target) && IsLocalUI(target) && target.AbsolutePath == "/auth/desktop-google") SignIn();
            };
            web.CoreWebView2.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs ev) {
                var deferral = ev.GetDeferral();
                ev.Handled = true;
                // Modal dialogs must run after the WebView callback returns.
                BeginInvoke(new Action(delegate {
                    try {
                        if (IsDisposed) { ev.Cancel = true; return; }
                        using (var dialog = new SaveFileDialog()) {
                            string suggested = Path.GetFileName(ev.ResultFilePath);
                            dialog.FileName = string.IsNullOrWhiteSpace(suggested) ? "Pixel Studio.png" : suggested;
                            dialog.Filter = "Все файлы (*.*)|*.*";
                            dialog.OverwritePrompt = true;
                            if (dialog.ShowDialog(this) == DialogResult.OK) ev.ResultFilePath = dialog.FileName; else ev.Cancel = true;
                        }
                    } finally { deferral.Complete(); }
                }));
            };
            web.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs ev) {
                // Native Google sign-in intentionally cancels the internal navigation.
                if (!ev.IsSuccess && ev.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                if (ev.IsSuccess) { loading.Visible = false; web.Focus(); }
                else { loading.Visible = true; loading.BringToFront(); status.Text = "Не удалось открыть встроенный редактор.\n\nПовторите запуск приложения."; retry.Visible = true; }
            };
            web.CoreWebView2.ProcessFailed += delegate { loading.Visible = true; loading.BringToFront(); status.Text = "Редактор остановился.\nЗакройте приложение и откройте его снова."; };
            web.CoreWebView2.Navigate(DesktopApp.LocalOrigin + "/index.html");
        } catch (Exception ex) {
            status.Text = "Не удалось запустить редактор.\n\n" + ex.Message;
            retry.Visible = true;
        } finally { initializing = false; }
    }
}


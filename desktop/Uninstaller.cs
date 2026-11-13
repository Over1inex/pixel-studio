using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
[assembly: AssemblyTitle("Удаление Pixel Studio")]
[assembly: AssemblyVersion("0.2.1.0")]

internal static class Uninstaller {
    internal static bool IsChild(string path, string directory) {
        string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }
    internal static bool IsApp(string path, string root) {
        if (!IsChild(path, root) || !string.Equals(Path.GetDirectoryName(Path.GetFullPath(path)), root, StringComparison.OrdinalIgnoreCase)) return false;
        if (!Regex.IsMatch(Path.GetFileName(path), @"\APixel Studio(?: Local(?: \d+\.\d+(?:\.\d+)?)?| \d+\.\d+\.\d+)?\.exe\z", RegexOptions.IgnoreCase)) return false;
        try { return FileVersionInfo.GetVersionInfo(path).FileDescription == "Pixel Studio"; } catch { return false; }
    }
    [STAThread]
    private static int Main(string[] args) {
        if (Array.IndexOf(args, "--self-test") >= 0) {
            string root = Path.Combine(Path.GetTempPath(), "PixelStudio-Uninstall-Test");
            return IsChild(Path.Combine(root, "test.exe"), root) && !IsChild(root + "-outside/test.exe", root) && !IsChild(Path.Combine(root, "../outside.exe"), root) &&
                Assembly.GetExecutingAssembly().GetManifestResourceStream("PixelStudio.Uninstall.ps1") != null ? 0 : 1;
        }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new UninstallWindow()); return 0; }
        catch (Exception error) { MessageBox.Show(error.Message, "Удаление Pixel Studio", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
    internal static void StartRemoval(bool removeData) {
        string self = Assembly.GetExecutingAssembly().Location;
        string root = Path.GetDirectoryName(Path.GetFullPath(self));
        var apps = new List<string>();
        foreach (string file in Directory.GetFiles(root, "*.exe", SearchOption.TopDirectoryOnly)) if (IsApp(file, root)) apps.Add(Path.GetFullPath(file));
        if (apps.Count == 0) throw new InvalidOperationException("Рядом не найден Pixel Studio.exe. Поместите программу удаления в папку с приложением и запустите снова.");
        foreach (var process in Process.GetProcesses()) {
            bool running = false;
            try {
                running = apps.Exists(path => string.Equals(path, process.MainModule.FileName, StringComparison.OrdinalIgnoreCase));
            } catch (System.ComponentModel.Win32Exception) { } catch (InvalidOperationException) { } finally { process.Dispose(); }
            if (running) throw new InvalidOperationException("Сначала сохраните проекты и закройте все окна Pixel Studio, затем повторите удаление.");
        }
        string dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PixelStudio");
        var plan = new { root, apps, self, dataDirectory, removeData, parentId = Process.GetCurrentProcess().Id };
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(plan)));
        string script;
        using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("PixelStudio.Uninstall.ps1"))
        using (var reader = new StreamReader(resource, Encoding.UTF8)) script = reader.ReadToEnd();
        script = "$taskPlan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')) | ConvertFrom-Json\n" + script;
        string command = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        Process.Start(new ProcessStartInfo {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand " + command,
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System),
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
        });
    }
}

internal sealed class UninstallWindow : Form {
    private readonly CheckBox data = new CheckBox();
    internal UninstallWindow() {
        Text = "Удаление Pixel Studio 0.2.1"; ClientSize = new Size(520, 335); FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 10);
        Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        var title = new Label { Text = "Удалить Pixel Studio с этого ПК?", Font = new Font("Segoe UI", 15, FontStyle.Bold), Location = new Point(24, 22), Size = new Size(475, 40) };
        var message = new Label { Text = "Будут удалены EXE приложения в этой папке, программа удаления и ярлык.\n\nСохранённые изображения, файлы проектов, исходники и облачные проекты останутся на месте.", Location = new Point(24, 76), Size = new Size(470, 103) };
        data.Text = "Удалить настройки, кеш и данные входа на этом ПК"; data.Checked = true; data.Location = new Point(24, 192); data.Size = new Size(470, 29);
        var note = new Label { Text = "Перед удалением сохраните проекты и закройте редактор.", ForeColor = Color.DimGray, Location = new Point(24, 230), Size = new Size(470, 25) };
        var remove = new Button { Text = "Удалить программу", Location = new Point(198, 281), Size = new Size(176, 34) };
        var cancel = new Button { Text = "Отмена", Location = new Point(385, 281), Size = new Size(110, 34), DialogResult = DialogResult.Cancel };
        cancel.Click += delegate { Close(); };
        remove.Click += delegate {
            try { Uninstaller.StartRemoval(data.Checked); Close(); }
            catch (Exception error) { MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Information); }
        };
        CancelButton = cancel; Controls.AddRange(new Control[] { title, message, data, note, remove, cancel });
    }
}

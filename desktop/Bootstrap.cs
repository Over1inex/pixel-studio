using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows.Forms;
[assembly: AssemblyTitle("Pixel Studio")]
[assembly: AssemblyDescription("Автономный редактор изображений со слоями и облачными проектами")]
[assembly: AssemblyVersion("1.1.0.0")]
internal static class Bootstrap {
    [STAThread]
    private static int Main(string[] args) {
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs ev) {
            string name = new AssemblyName(ev.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name + ".dll")) {
                if (stream == null) return null;
                using (var buffer = new MemoryStream()) { stream.CopyTo(buffer); return Assembly.Load(buffer.ToArray()); }
            }
        };
        try { return Run(args); }
        catch (Exception ex) { if (Array.IndexOf(args, "--self-test") < 0) MessageBox.Show(ex.Message, "Pixel Studio", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args) { return DesktopApp.Run(args); }
}

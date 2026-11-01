using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;

namespace Udc.Client;

/// <summary>
/// Persists the bearer token issued by <c>POST /api/mobile/login</c> across app restarts, encrypted
/// at rest with Windows DPAPI (<see cref="ProtectedData"/>, current-user scope) so the raw token
/// never sits in a plain-text file. Windows-only, same as the rest of this app.
/// </summary>
[SupportedOSPlatform("windows")]
public static class TokenStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("UrbanDryCleanCRM.token.v1");

    public static void Save(string token)
    {
        Paths.EnsureAppDataRoot();
        var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(Paths.TokenFile, protectedBytes);
    }

    public static string? Load()
    {
        try
        {
            var protectedBytes = File.ReadAllBytes(Paths.TokenFile);
            var bytes = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch (IOException) { return null; }
        catch (CryptographicException) { return null; } // corrupted or written by a different user profile
    }

    public static void Clear()
    {
        try { File.Delete(Paths.TokenFile); } catch (IOException) { /* nothing to clear */ }
    }
}

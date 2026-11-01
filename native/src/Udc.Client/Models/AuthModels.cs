using System.Text.Json.Serialization;

namespace Udc.Client.Models;

public sealed class LoginResult
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = "";

    [JsonPropertyName("expires_at")]
    public string ExpiresAt { get; set; } = "";

    [JsonPropertyName("user")]
    public UserContext User { get; set; } = new();
}

public sealed class UserContext
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("username")]
    public string Username { get; set; } = "";

    [JsonPropertyName("full_name")]
    public string FullName { get; set; } = "";

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("role_id")]
    public int RoleId { get; set; }

    [JsonPropertyName("role_name")]
    public string RoleName { get; set; } = "";

    [JsonPropertyName("store_id")]
    public int? StoreId { get; set; }

    [JsonPropertyName("permissions")]
    public List<string> Permissions { get; set; } = new();
}

public sealed class MeResult
{
    [JsonPropertyName("user")]
    public MeUser User { get; set; } = new();

    [JsonPropertyName("store")]
    public MeStoreInfo Store { get; set; } = new();

    [JsonPropertyName("permissions")]
    public List<string> Permissions { get; set; } = new();
}

public sealed class MeUser
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("username")]
    public string Username { get; set; } = "";

    [JsonPropertyName("full_name")]
    public string FullName { get; set; } = "";

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("role_id")]
    public int RoleId { get; set; }

    [JsonPropertyName("role_name")]
    public string RoleName { get; set; } = "";
}

public sealed class MeStoreInfo
{
    [JsonPropertyName("fixed_store")]
    public StoreRef? FixedStore { get; set; }

    [JsonPropertyName("requires_store_selection")]
    public bool RequiresStoreSelection { get; set; }

    [JsonPropertyName("available_stores")]
    public List<StoreRef> AvailableStores { get; set; } = new();
}

public sealed class StoreRef
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";
}

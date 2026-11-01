using Udc.Client;
using Xunit;

namespace Udc.Client.Tests;

public class AppConfigTests
{
    [Fact]
    public void Merge_FirstRun_BlankSecretKey_GeneratesANewOne()
    {
        var submitted = new AppConfig { DbName = "udc", DbUser = "root", AppSecretKey = "" };

        var merged = AppConfig.Merge(existing: null, submitted);

        Assert.False(string.IsNullOrWhiteSpace(merged.AppSecretKey));
        Assert.Equal(64, merged.AppSecretKey.Length); // 32 random bytes, hex-encoded
    }

    [Fact]
    public void Merge_LaterEdit_BlankSecretKey_KeepsTheExistingOne()
    {
        var existing = new AppConfig { DbName = "udc", DbUser = "root", AppSecretKey = "existing-secret-key" };
        var submitted = new AppConfig { DbName = "udc", DbUser = "root", AppSecretKey = "" };

        var merged = AppConfig.Merge(existing, submitted);

        Assert.Equal("existing-secret-key", merged.AppSecretKey);
    }

    [Fact]
    public void Merge_LaterEdit_BlankPassword_KeepsTheExistingOne()
    {
        var existing = new AppConfig { DbName = "udc", DbUser = "root", DbPass = "s3cret", AppSecretKey = "k" };
        var submitted = new AppConfig { DbName = "udc", DbUser = "root", DbPass = "", AppSecretKey = "k" };

        var merged = AppConfig.Merge(existing, submitted);

        Assert.Equal("s3cret", merged.DbPass);
    }

    [Fact]
    public void Merge_NewPasswordOrSecretKey_OverridesTheOldOne()
    {
        var existing = new AppConfig { DbName = "udc", DbUser = "root", DbPass = "old", AppSecretKey = "old-key" };
        var submitted = new AppConfig { DbName = "udc", DbUser = "root", DbPass = "new", AppSecretKey = "new-key" };

        var merged = AppConfig.Merge(existing, submitted);

        Assert.Equal("new", merged.DbPass);
        Assert.Equal("new-key", merged.AppSecretKey);
    }

    [Theory]
    [InlineData("", "root", false)]
    [InlineData("udc", "", false)]
    [InlineData("udc", "root", true)]
    public void IsComplete_RequiresDbNameAndUser(string dbName, string dbUser, bool expected)
    {
        var config = new AppConfig { DbName = dbName, DbUser = dbUser };
        Assert.Equal(expected, config.IsComplete);
    }
}

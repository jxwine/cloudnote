# 签名密钥（别提交、务必备份）

`cloudnote.jks` 和 `keystore.properties` 已在 .gitignore 里。**丢了这个 jks，以后打的包就不能覆盖安装到
已经装了旧版的手机上**（安卓认签名不认包名），只能卸了重装、本地缓存清空。把这两个文件拷一份到安全的地方。

没有这两个文件时 `gradlew assembleRelease` 会出未签名包（装不上）；重新生成：

```
keytool -genkeypair -v -keystore keystore/cloudnote.jks -alias cloudnote -keyalg RSA -keysize 2048 -validity 10000
```

然后照 `keystore.properties.example` 写一份 `keystore.properties`。

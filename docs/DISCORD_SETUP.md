# Discord Bot Setup Guide

Complete step-by-step guide to setting up your Discord bot for the Discord Agent Bridge.

Discord Agent Bridge를 위한 Discord 봇 설정 완전 가이드입니다.

---

## 1. Creating a Discord Bot

**디스코드 봇 생성하기**

### Step 1.1: Create a New Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click the **"New Application"** button (top right corner)
3. Enter a name for your bot (e.g., "AI Agent Bridge")
4. Accept the Terms of Service and click **"Create"**

**애플리케이션 생성**

1. [Discord Developer Portal](https://discord.com/developers/applications)에 접속합니다
2. 우측 상단의 **"New Application"** 버튼을 클릭합니다
3. 봇의 이름을 입력합니다 (예: "AI Agent Bridge")
4. 서비스 약관에 동의하고 **"Create"**를 클릭합니다

### Step 1.2: Create the Bot User

1. In your application page, click on the **"Bot"** tab in the left sidebar
2. Click **"Add Bot"** button
3. Confirm by clicking **"Yes, do it!"**
4. You should see "A wild bot has appeared!" message

**봇 유저 생성**

1. 애플리케이션 페이지에서 좌측 사이드바의 **"Bot"** 탭을 클릭합니다
2. **"Add Bot"** 버튼을 클릭합니다
3. **"Yes, do it!"**을 클릭하여 확인합니다
4. "A wild bot has appeared!" 메시지가 표시됩니다

### Step 1.3: Copy the Bot Token

1. In the Bot page, find the **"TOKEN"** section
2. Click **"Reset Token"** (first time) or **"Copy"** (if token already exists)
3. **IMPORTANT**: Save this token securely - you'll need it for setup
4. **WARNING**: Never share this token publicly or commit it to git

**봇 토큰 복사**

1. Bot 페이지에서 **"TOKEN"** 섹션을 찾습니다
2. **"Reset Token"** (처음) 또는 **"Copy"** (이미 생성된 경우)를 클릭합니다
3. **중요**: 이 토큰을 안전하게 저장하세요 - 설정 시 필요합니다
4. **경고**: 이 토큰을 공개적으로 공유하거나 git에 커밋하지 마세요

### Step 1.4: Enable Privileged Gateway Intents

**CRITICAL**: The bot requires specific intents to read message content.

1. Scroll down to the **"Privileged Gateway Intents"** section
2. Enable the following intents:
   - ✅ **MESSAGE CONTENT INTENT** (Required)
   - ✅ **SERVER MEMBERS INTENT** (Optional, for member-related features)
3. Click **"Save Changes"** at the bottom

**중요한 권한 설정**

**필수**: 봇이 메시지 내용을 읽으려면 특정 인텐트가 필요합니다.

1. **"Privileged Gateway Intents"** 섹션으로 스크롤합니다
2. 다음 인텐트를 활성화합니다:
   - ✅ **MESSAGE CONTENT INTENT** (필수)
   - ✅ **SERVER MEMBERS INTENT** (선택, 멤버 관련 기능용)
3. 하단의 **"Save Changes"**를 클릭합니다

**Why these intents are needed / 이 인텐트가 필요한 이유:**
- **MESSAGE CONTENT INTENT**: Allows the bot to read message text for commands and interactions
  - 봇이 명령어와 상호작용을 위해 메시지 텍스트를 읽을 수 있게 합니다
- **SERVER MEMBERS INTENT**: Allows the bot to track server members (optional)
  - 봇이 서버 멤버를 추적할 수 있게 합니다 (선택사항)

---

## 2. Getting Your Server ID

**서버 ID 가져오기**

### Step 2.1: Enable Developer Mode

1. Open Discord and click the **gear icon** (User Settings) at the bottom left
2. Go to **"Advanced"** in the left sidebar (under "App Settings")
3. Enable **"Developer Mode"** toggle
4. Close settings

**개발자 모드 활성화**

1. Discord를 열고 좌측 하단의 **톱니바퀴 아이콘** (사용자 설정)을 클릭합니다
2. 좌측 사이드바에서 **"고급"** ("앱 설정" 아래)으로 이동합니다
3. **"개발자 모드"** 토글을 활성화합니다
4. 설정을 닫습니다

### Step 2.2: Copy Server ID

1. Right-click on your **server name** (or server icon) in the server list
2. Click **"Copy Server ID"** at the bottom of the menu
3. Save this ID - you may need it for manual configuration

**서버 ID 복사**

1. 서버 목록에서 **서버 이름** (또는 서버 아이콘)을 우클릭합니다
2. 메뉴 하단의 **"서버 ID 복사"**를 클릭합니다
3. 이 ID를 저장하세요 - 수동 설정 시 필요할 수 있습니다

**Note / 참고:**
- The `agent-discord setup` command will auto-detect your server ID if you run it while Discord is active
- `agent-discord setup` 명령은 Discord가 활성화된 상태에서 실행하면 서버 ID를 자동으로 감지합니다
- Manual configuration: `agent-discord config --server YOUR_SERVER_ID`
- 수동 설정: `agent-discord config --server YOUR_SERVER_ID`

---

## 3. Inviting the Bot to Your Server

**봇을 서버에 초대하기**

### Step 3.1: Generate Invite URL

1. Go back to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Click on **"OAuth2"** in the left sidebar
4. Click on **"URL Generator"**

**초대 URL 생성**

1. [Discord Developer Portal](https://discord.com/developers/applications)로 돌아갑니다
2. 애플리케이션을 선택합니다
3. 좌측 사이드바의 **"OAuth2"**를 클릭합니다
4. **"URL Generator"**를 클릭합니다

### Step 3.2: Select Scopes

In the **"SCOPES"** section, check:
- ✅ **bot**

**범위 선택**

**"SCOPES"** 섹션에서 다음을 체크합니다:
- ✅ **bot**

### Step 3.3: Select Bot Permissions

In the **"BOT PERMISSIONS"** section that appears below, check:

**Text Permissions:**
- ✅ **Send Messages** - Required to send agent output
- ✅ **Send Messages in Threads** - For thread support
- ✅ **Embed Links** - For rich message formatting
- ✅ **Attach Files** - For sending logs or files
- ✅ **Read Message History** - For context tracking
- ✅ **Add Reactions** - For interactive responses (optional)

**General Permissions:**
- ✅ **View Channels** - Required to see and access channels
- ✅ **Manage Channels** - For creating agent-specific channels (optional)

**봇 권한 선택**

하단에 나타나는 **"BOT PERMISSIONS"** 섹션에서 다음을 체크합니다:

**텍스트 권한:**
- ✅ **Send Messages** - 에이전트 출력 전송에 필요
- ✅ **Send Messages in Threads** - 쓰레드 지원용
- ✅ **Embed Links** - 리치 메시지 포맷팅용
- ✅ **Attach Files** - 로그나 파일 전송용
- ✅ **Read Message History** - 컨텍스트 추적용
- ✅ **Add Reactions** - 인터랙티브 응답용 (선택)

**일반 권한:**
- ✅ **View Channels** - 채널 보기 및 접근에 필요
- ✅ **Manage Channels** - 에이전트 전용 채널 생성용 (선택)

### Step 3.4: Invite the Bot

1. Copy the **generated URL** at the bottom of the page
2. Open the URL in your web browser
3. Select the **server** you want to add the bot to from the dropdown
4. Click **"Continue"**
5. Review the permissions and click **"Authorize"**
6. Complete the CAPTCHA verification
7. You should see "Success! [Bot Name] has been added to [Server Name]"

**봇 초대하기**

1. 페이지 하단의 **생성된 URL**을 복사합니다
2. 웹 브라우저에서 URL을 엽니다
3. 드롭다운에서 봇을 추가할 **서버**를 선택합니다
4. **"계속하기"**를 클릭합니다
5. 권한을 확인하고 **"승인"**을 클릭합니다
6. CAPTCHA 인증을 완료합니다
7. "Success! [Bot Name] has been added to [Server Name]" 메시지가 표시됩니다

---

## 4. Required Bot Permissions

**필수 봇 권한**

### Minimum Required Permissions

| Permission | Required? | Purpose |
|------------|-----------|---------|
| View Channels | ✅ Yes | Bot must see channels to operate |
| Send Messages | ✅ Yes | Send agent output to Discord |
| Read Message History | ✅ Yes | Track conversation context |
| Embed Links | ⚠️ Recommended | Format rich messages |
| Attach Files | ⚠️ Recommended | Send logs or output files |
| Manage Channels | ❌ Optional | Auto-create agent channels |
| Add Reactions | ❌ Optional | Interactive button responses |

**최소 필수 권한**

| 권한 | 필수 여부 | 목적 |
|------|----------|------|
| View Channels (채널 보기) | ✅ 필수 | 봇이 작동하려면 채널을 볼 수 있어야 함 |
| Send Messages (메시지 전송) | ✅ 필수 | 에이전트 출력을 Discord로 전송 |
| Read Message History (메시지 기록 읽기) | ✅ 필수 | 대화 컨텍스트 추적 |
| Embed Links (링크 임베드) | ⚠️ 권장 | 리치 메시지 포맷팅 |
| Attach Files (파일 첨부) | ⚠️ 권장 | 로그나 출력 파일 전송 |
| Manage Channels (채널 관리) | ❌ 선택 | 에이전트 전용 채널 자동 생성 |
| Add Reactions (반응 추가) | ❌ 선택 | 인터랙티브 버튼 응답 |

### Permission Issues

If the bot cannot send messages, check:
1. Server-level permissions are granted
2. Channel-specific permissions override (check channel settings)
3. Bot role is not placed below other restrictive roles

**권한 문제**

봇이 메시지를 보낼 수 없다면 확인하세요:
1. 서버 레벨 권한이 부여되었는지
2. 채널별 권한 재정의 여부 (채널 설정 확인)
3. 봇 역할이 다른 제한적인 역할보다 아래에 있지 않은지

---

## 5. Verifying Setup

**설정 확인**

### Step 5.1: Run Setup Command

```bash
npx agent-discord setup YOUR_BOT_TOKEN
```

Replace `YOUR_BOT_TOKEN` with the token you copied in Step 1.3.

`YOUR_BOT_TOKEN`을 Step 1.3에서 복사한 토큰으로 바꾸세요.

### Step 5.2: Expected Output

**Successful Setup:**
```
✓ Discord bot token configured
✓ Connected to Discord
✓ Bot is online: AI Agent Bridge#1234
✓ Found server: My Awesome Server (ID: 123456789...)
✓ Configuration saved to ~/.config/agent-discord/config.json

Setup complete! Your bot is ready to use.

Next steps:
1. Run: npx agent-discord start claude
2. The bot will create a channel named 'agent-claude-XXXXX'
3. All Claude CLI output will stream to that channel
```

**성공적인 설정:**
```
✓ Discord 봇 토큰이 설정되었습니다
✓ Discord에 연결되었습니다
✓ 봇이 온라인입니다: AI Agent Bridge#1234
✓ 서버를 찾았습니다: My Awesome Server (ID: 123456789...)
✓ 설정이 ~/.config/agent-discord/config.json에 저장되었습니다

설정 완료! 봇을 사용할 준비가 되었습니다.

다음 단계:
1. 실행: npx agent-discord start claude
2. 봇이 'agent-claude-XXXXX' 채널을 생성합니다
3. 모든 Claude CLI 출력이 해당 채널로 스트리밍됩니다
```

### Step 5.3: Verify Bot is Online

1. Open Discord
2. Check your server's member list (right sidebar)
3. Look for your bot name with a "BOT" tag
4. The bot should show as **online** (green status)

**봇이 온라인인지 확인**

1. Discord를 엽니다
2. 서버의 멤버 목록을 확인합니다 (우측 사이드바)
3. "BOT" 태그가 있는 봇 이름을 찾습니다
4. 봇이 **온라인** (초록색 상태)으로 표시되어야 합니다

### Step 5.4: Test with a Command

```bash
npx agent-discord start claude
```

Then in your terminal, type a message and press Enter. You should see:
- A new channel created in Discord (if auto-channel is enabled)
- Your message appear in that channel
- Bot responding with agent output

**명령어로 테스트**

```bash
npx agent-discord start claude
```

터미널에 메시지를 입력하고 Enter를 누르세요. 다음이 보여야 합니다:
- Discord에 새 채널 생성됨 (자동 채널이 활성화된 경우)
- 해당 채널에 메시지가 나타남
- 봇이 에이전트 출력으로 응답함

---

## Troubleshooting

**문제 해결**

### Bot shows as offline
**봇이 오프라인으로 표시됨**

- Check the token is correct
  - 토큰이 올바른지 확인하세요
- Verify the bot is invited to your server
  - 봇이 서버에 초대되었는지 확인하세요
- Check network/firewall settings
  - 네트워크/방화벽 설정을 확인하세요

### Bot cannot send messages
**봇이 메시지를 보낼 수 없음**

- Verify "Send Messages" permission is granted
  - "메시지 전송" 권한이 부여되었는지 확인하세요
- Check channel-specific permission overrides
  - 채널별 권한 재정의를 확인하세요
- Ensure bot role is above other roles that restrict permissions
  - 봇 역할이 권한을 제한하는 다른 역할보다 위에 있는지 확인하세요

### "Missing Access" error
**"액세스 누락" 오류**

- The bot was not properly invited - regenerate the invite URL and invite again
  - 봇이 제대로 초대되지 않았습니다 - 초대 URL을 다시 생성하고 재초대하세요
- Check "View Channels" permission is granted
  - "채널 보기" 권한이 부여되었는지 확인하세요

### "Invalid Token" error
**"잘못된 토큰" 오류**

- Token may have been regenerated - get a fresh token from Developer Portal
  - 토큰이 재생성되었을 수 있습니다 - Developer Portal에서 새 토큰을 받으세요
- Ensure no extra spaces when copying the token
  - 토큰 복사 시 불필요한 공백이 없는지 확인하세요
- Run `npx agent-discord setup` again with the new token
  - 새 토큰으로 `npx agent-discord setup`을 다시 실행하세요

### Cannot read messages or detect commands
**메시지를 읽거나 명령을 감지할 수 없음**

- **CRITICAL**: Enable "MESSAGE CONTENT INTENT" in Bot settings (Step 1.4)
  - **중요**: Bot 설정에서 "MESSAGE CONTENT INTENT"를 활성화하세요 (Step 1.4)
- Without this intent, the bot cannot read message content
  - 이 인텐트 없이는 봇이 메시지 내용을 읽을 수 없습니다

---

## Security Best Practices

**보안 모범 사례**

1. **Never commit your bot token to git**
   - Use environment variables or config files with proper `.gitignore`
   - **봇 토큰을 절대 git에 커밋하지 마세요**
     - 환경 변수나 `.gitignore`가 적용된 설정 파일을 사용하세요

2. **Regenerate token if exposed**
   - If you accidentally share your token, regenerate it immediately in Developer Portal
   - **토큰이 노출되면 즉시 재생성하세요**
     - 실수로 토큰을 공유했다면 Developer Portal에서 즉시 재생성하세요

3. **Limit bot permissions**
   - Only grant permissions the bot actually needs
   - **봇 권한을 제한하세요**
     - 봇이 실제로 필요한 권한만 부여하세요

4. **Use separate bots for testing and production**
   - Create different bot applications for development and live servers
   - **테스트와 프로덕션에 별도의 봇을 사용하세요**
     - 개발용과 라이브 서버용으로 다른 봇 애플리케이션을 만드세요

---

## Additional Resources

**추가 자료**

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Discord Agent Bridge README](../README.md)

---

## Quick Reference Card

**빠른 참조 카드**

```
1. Create bot at: https://discord.com/developers/applications
   봇 생성: https://discord.com/developers/applications

2. Enable intents: MESSAGE CONTENT INTENT (required)
   인텐트 활성화: MESSAGE CONTENT INTENT (필수)

3. Copy bot token from Bot tab
   Bot 탭에서 봇 토큰 복사

4. Generate invite URL from OAuth2 > URL Generator
   OAuth2 > URL Generator에서 초대 URL 생성
   - Scope: bot
   - Permissions: View Channels, Send Messages, Read Message History

5. Invite bot to server
   서버에 봇 초대

6. Run: npx agent-discord setup YOUR_TOKEN
   실행: npx agent-discord setup YOUR_TOKEN

7. Start using: npx agent-discord start claude
   사용 시작: npx agent-discord start claude
```

---

**Last Updated**: 2026-02-09
**Version**: 1.0.0

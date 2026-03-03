import mixpanel from "mixpanel-browser";

const MIXPANEL_TOKEN = "f9964661bdefbfa47215c21a11770db2";
const MIXPANEL_USER_ID_KEY = "discode-mixpanel-user-id";

function getOrCreateMixpanelUserId() {
  try {
    const saved = window.localStorage.getItem(MIXPANEL_USER_ID_KEY);
    if (saved) return saved;
    const generated = `visitor_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(MIXPANEL_USER_ID_KEY, generated);
    return generated;
  } catch {
    return `visitor_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function trackMixpanelEvent(eventName, properties) {
  if (typeof mixpanel.track !== "function") return;
  mixpanel.track(eventName, properties);
}

const mixpanelUserId = getOrCreateMixpanelUserId();
try {
  mixpanel.init(MIXPANEL_TOKEN, {
    debug: true,
    track_pageview: true,
    persistence: "localStorage",
    autocapture: true,
    record_sessions_percent: 100,
  });
  mixpanel.identify(mixpanelUserId);
  if (mixpanel.people && typeof mixpanel.people.set === "function") {
    mixpanel.people.set({ plan: "Visitor" });
  }
} catch {
  // Ignore analytics initialization failures on static pages.
}

trackMixpanelEvent("Page View", {
  page_url: window.location.href,
  page_title: document.title,
  user_id: mixpanelUserId,
});

const installCommands = {
  bun: "bun add -g @siisee11/discode",
  npm: "npm install -g @siisee11/discode",
  curl: "curl -fsSL https://discode.chat/install | bash",
  brew: "# coming soon",
};

const tabs = Array.from(document.querySelectorAll(".tab[data-tab]"));
const installCommand = document.getElementById("install-command");
const installCopyButton = document.getElementById("install-copy-btn");
const languageSelects = Array.from(document.querySelectorAll("[data-language-select]"));

const copyLabels = {
  en: {
    copy: "Copy",
    copied: "Copied",
    aria: "Copy install command",
  },
  ko: {
    copy: "복사",
    copied: "복사됨",
    aria: "설치 명령어 복사",
  },
};

function currentLanguage() {
  const lang = (document.documentElement.lang || "en").toLowerCase();
  return lang.startsWith("ko") ? "ko" : "en";
}

function updateCopyButtonLabel(mode = "copy") {
  if (!installCopyButton) return;
  const labels = copyLabels[currentLanguage()] || copyLabels.en;
  installCopyButton.textContent = labels[mode] || labels.copy;
  installCopyButton.setAttribute("aria-label", labels.aria);
}

function fallbackCopy(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

function activateTab(nextTab) {
  const tabKey = nextTab.dataset.tab;
  if (!tabKey || !installCommand) return;

  tabs.forEach((tab) => {
    const isActive = tab === nextTab;
    tab.classList.toggle("tab-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  installCommand.textContent = installCommands[tabKey] || "";
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab));
});

if (installCopyButton) {
  installCopyButton.addEventListener("click", () => {
    if (!installCommand) return;
    const text = installCommand.textContent || "";
    if (!text) return;

    const writePromise = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.resolve().then(() => fallbackCopy(text));

    writePromise
      .then(() => {
        trackMixpanelEvent("Conversion", {
          "Conversion Type": "install_command_copy",
          "Conversion Value": 1,
        });
        updateCopyButtonLabel("copied");
        window.setTimeout(() => updateCopyButtonLabel("copy"), 1400);
      })
      .catch(() => {
        fallbackCopy(text);
        updateCopyButtonLabel("copied");
        window.setTimeout(() => updateCopyButtonLabel("copy"), 1400);
      });
  });

  languageSelects.forEach((select) => {
    select.addEventListener("change", () => {
      window.setTimeout(() => updateCopyButtonLabel("copy"), 0);
    });
  });

  updateCopyButtonLabel("copy");
}

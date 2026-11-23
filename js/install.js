"use strict";

const language = document.getElementById("language");
const action = document.getElementById("agreeBtn");
const actionLabel = action.querySelector("span");
const firstStep = document.getElementById("first-step");
const guide = new URLSearchParams(location.search).has("guide");
const uiLanguage = chrome.i18n.getUILanguage();
const preferred = !/^zh/i.test(uiLanguage) ? "en" : /TW|HK|MO|Hant/i.test(uiLanguage) ? "zh_TW" : "zh_CN";

if (guide) {
    document.getElementById("headline").dataset.copy = "welcomeGuideHeading";
    actionLabel.dataset.copy = "welcomeClose";
    document.getElementById("agreement").hidden = true;
}
if (!chrome.sidePanel?.setPanelBehavior && !globalThis.browser?.sidebarAction?.open) {
    document.getElementById("save-step").dataset.copy = "welcomeSaveList";
    if (guide) document.getElementById("headline").dataset.copy = "welcomeGuide";
}

function renderLanguage(locale, message) {
    document.documentElement.lang = locale.replace("_", "-");
    document.querySelectorAll("[data-copy]").forEach(node => {
        node.textContent = message(node.dataset.copy);
    });
    document.title = guide ? message("welcomeGuide") + " · " + message("extensionName") : message("welcomeInstalled");
}

async function changeLanguage() {
    const selected = language.value;
    // The browser only localizes into its own language. The selector also works offline.
    try {
        const response = await fetch(chrome.runtime.getURL("_locales/" + selected + "/messages.json"));
        if (!response.ok) throw new Error("Language unavailable");
        const messages = await response.json();
        if (language.value === selected) renderLanguage(selected, key => messages[key].message);
    } catch {
        if (language.value !== selected) return;
        language.value = preferred;
        renderLanguage(preferred, key => chrome.i18n.getMessage(key));
    }
}

language.addEventListener("change", changeLanguage);

chrome.tabs.getCurrent(tab => {
    let openPanel;
    if (!guide && tab) {
        if (globalThis.browser?.sidebarAction?.open) openPanel = () => browser.sidebarAction.open();
        else if (chrome.sidePanel?.open) openPanel = () => chrome.sidePanel.open({ windowId: tab.windowId });
    }
    if (openPanel) {
        actionLabel.dataset.copy = "welcomeStart";
        firstStep.dataset.copy = "welcomeChoosePage";
    }
    language.value = preferred;
    renderLanguage(preferred, key => chrome.i18n.getMessage(key));
    changeLanguage();

    action.addEventListener("click", async () => {
        action.disabled = true;
        if (openPanel) {
            try {
                // Call inside the click handler while the browser still has the user's gesture.
                await openPanel();
            } catch {
                openPanel = null;
                firstStep.dataset.copy = "welcomeOpen";
                actionLabel.dataset.copy = "welcomeAgree";
                document.getElementById("panel-error").hidden = false;
                await changeLanguage();
                action.disabled = false;
                return;
            }
        }
        closeTab(tab?.id, tab?.windowId);
    });
});
document.getElementById("uninstallBtn").addEventListener("click", () => {
    chrome.management.uninstallSelf({ showConfirmDialog: true }, () => {
        // Dismissing the browser's confirmation keeps this page open.
        void chrome.runtime.lastError;
    });
});

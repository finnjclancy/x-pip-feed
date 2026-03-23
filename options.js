const LANGUAGES = [
  { code: "ar", name: "Arabic" },
  { code: "zh", name: "Chinese" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "fa", name: "Farsi / Persian" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ms", name: "Malay" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "vi", name: "Vietnamese" },
];

const DEFAULTS = {
  refreshInterval: 20,
  playSoundOnNewPosts: true,
  notificationSound: "bell",
  notificationVolume: 100,
  translateAccounts: [
    { username: "AJABreaking", fromLang: "ar" },
    { username: "idfonline", fromLang: "he" },
    { username: "mb_ghalibaf", fromLang: "fa" },
    { username: "Attaqa2", fromLang: "ar" },
    { username: "anasalhajji", fromLang: "ar" },
    { username: "Rahbarenghelab_", fromLang: "fa" },
    { username: "Khamenei_fa", fromLang: "fa" },
    { username: "alilarijani_ir", fromLang: "fa" },
  ],
};

const list = document.getElementById("account-list");
const addBtn = document.getElementById("add-account");
const saveBtn = document.getElementById("save");
const savedMsg = document.getElementById("saved-msg");
const intervalInput = document.getElementById("interval");
const soundToggle = document.getElementById("play-sound");
const soundSelect = document.getElementById("sound-type");
const volumeInput = document.getElementById("sound-volume");
const volumeValue = document.getElementById("sound-volume-value");
const presetContainer = document.getElementById("sound-presets");
const testSoundBtn = document.getElementById("test-sound");
let previewAudioContext = null;

function createLangSelect(selected) {
  const select = document.createElement("select");
  select.className = "lang-select";
  LANGUAGES.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.name;
    option.selected = language.code === selected;
    select.appendChild(option);
  });
  return select;
}

function addAccountRow(username, fromLang) {
  const row = document.createElement("div");
  row.className = "account-row";

  const at = document.createElement("span");
  at.style.color = "#1d9bf0";
  at.style.fontWeight = "700";
  at.textContent = "@";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "username";
  input.placeholder = "username";
  input.value = username || "";

  const select = createLangSelect(fromLang || "ar");

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.title = "Remove";
  removeBtn.type = "button";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(at);
  row.appendChild(input);
  row.appendChild(select);
  row.appendChild(removeBtn);
  list.appendChild(row);
}

function getFormData() {
  const accounts = [];
  list.querySelectorAll(".account-row").forEach((row) => {
    const username = row.querySelector(".username").value.trim().replace(/^@/, "");
    const fromLang = row.querySelector(".lang-select").value;
    if (username && fromLang) {
      accounts.push({ username, fromLang });
    }
  });

  let interval = parseInt(intervalInput.value, 10) || DEFAULTS.refreshInterval;
  if (interval < 10) interval = 10;
  if (interval > 30) interval = 30;
  let notificationVolume = parseInt(volumeInput.value, 10);
  if (!Number.isFinite(notificationVolume)) notificationVolume = DEFAULTS.notificationVolume;
  if (notificationVolume < 0) notificationVolume = 0;
  if (notificationVolume > 1000) notificationVolume = 1000;
  return {
    refreshInterval: interval,
    playSoundOnNewPosts: !!soundToggle.checked,
    notificationSound: soundSelect.value || DEFAULTS.notificationSound,
    notificationVolume,
    translateAccounts: accounts,
  };
}

function setVolumeUI(value) {
  const volume = Math.min(Math.max(parseInt(value, 10) || 0, 0), 1000);
  volumeInput.value = volume;
  volumeValue.textContent = volume + "%";
  presetContainer.querySelectorAll(".preset-btn").forEach((button) => {
    button.classList.toggle("active", parseInt(button.dataset.volume, 10) === volume);
  });
}

function ensurePreviewAudioContext() {
  if (previewAudioContext || typeof window.AudioContext === "undefined") {
    return previewAudioContext;
  }
  try {
    previewAudioContext = new window.AudioContext();
  } catch (error) {
    console.warn("Audio preview init failed:", error);
  }
  return previewAudioContext;
}

function playPreviewSound(soundType, volumePercent) {
  const ctx = ensurePreviewAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  const volume = Math.max(0.0001, Math.min(Math.max(volumePercent / 100, 0), 10) * 0.12);
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(volume, now);
  masterGain.connect(ctx.destination);

  const playTone = (type, frequency, start, duration, peakGain) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), start + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gainNode);
    gainNode.connect(masterGain);
    oscillator.start(start);
    oscillator.stop(start + duration);
  };

  if (soundType === "bell") {
    playTone("sine", 1046, now, 0.32, 0.7);
    playTone("sine", 1318, now + 0.03, 0.28, 0.45);
    return;
  }

  if (soundType === "pop") {
    playTone("square", 520, now, 0.09, 0.9);
    playTone("triangle", 760, now + 0.07, 0.08, 0.55);
    return;
  }

  playTone("triangle", 880, now, 0.16, 0.75);
  playTone("triangle", 660, now + 0.08, 0.16, 0.5);
}

// Load saved settings
chrome.storage.sync.get([
  "refreshInterval",
  "playSoundOnNewPosts",
  "notificationSound",
  "notificationVolume",
  "translateAccounts",
], (data) => {
  const interval = Number.isFinite(data.refreshInterval) ? data.refreshInterval : DEFAULTS.refreshInterval;
  const playSoundOnNewPosts = data.playSoundOnNewPosts ?? DEFAULTS.playSoundOnNewPosts;
  const notificationSound = data.notificationSound || DEFAULTS.notificationSound;
  const notificationVolume = Number.isFinite(data.notificationVolume)
    ? data.notificationVolume
    : DEFAULTS.notificationVolume;
  const translateAccounts = Array.isArray(data.translateAccounts)
    ? data.translateAccounts
    : DEFAULTS.translateAccounts;
  intervalInput.value = interval;
  soundToggle.checked = !!playSoundOnNewPosts;
  soundSelect.value = notificationSound;
  setVolumeUI(notificationVolume);
  translateAccounts.forEach((account) => addAccountRow(account.username, account.fromLang));
});

volumeInput.addEventListener("input", () => {
  setVolumeUI(volumeInput.value);
});

presetContainer.querySelectorAll(".preset-btn").forEach((button) => {
  button.addEventListener("click", () => {
    setVolumeUI(button.dataset.volume);
  });
});

testSoundBtn.addEventListener("click", () => {
  const soundType = soundSelect.value || DEFAULTS.notificationSound;
  const volumePercent = parseInt(volumeInput.value, 10) || 0;
  playPreviewSound(soundType, volumePercent);
});

addBtn.addEventListener("click", () => {
  addAccountRow("", "ar");
});

saveBtn.addEventListener("click", () => {
  const data = getFormData();
  chrome.storage.sync.set(data, () => {
    savedMsg.classList.add("show");
    setTimeout(() => savedMsg.classList.remove("show"), 2000);
  });
});

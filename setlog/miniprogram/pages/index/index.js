const api = require("../../utils/api");

function getTimeZone() {
  return getApp().globalData.timeZone || "Europe/Rome";
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: getTimeZone() });
}

function isoNow() {
  return new Date().toISOString();
}

function formatLocalDateTime(value) {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: getTimeZone(),
    hour12: false
  });
}

function buildViewModel({ users, logs, clips, dailyVlogs, logMembers, userIndex, logIndex, dateKey }) {
  const normalizedUsers = Array.isArray(users) ? users : [];
  const normalizedLogs = Array.isArray(logs) ? logs : [];
  const normalizedClips = Array.isArray(clips) ? clips : [];
  const normalizedDailyVlogs = Array.isArray(dailyVlogs) ? dailyVlogs : [];
  const normalizedLogMembers = Array.isArray(logMembers) ? logMembers : [];

  const safeUserIndex = normalizedUsers.length ? Math.min(Math.max(userIndex || 0, 0), normalizedUsers.length - 1) : 0;
  const safeLogIndex = normalizedLogs.length ? Math.min(Math.max(logIndex || 0, 0), normalizedLogs.length - 1) : 0;
  const selectedUser = normalizedUsers[safeUserIndex] || null;
  const selectedLog = normalizedLogs[safeLogIndex] || null;
  const annotatedClips = normalizedClips
    .map((clip) => ({
      ...clip,
      userName: clip.userName || "",
      logName: clip.logName || "",
      recordedLocal: formatLocalDateTime(clip.recordedAt)
    }))
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
  const annotatedLogs = normalizedLogs.map((log) => {
    const relatedClips = annotatedClips.filter((clip) => clip.logId === log.id);
    const lastClip = relatedClips[0];
    return {
      ...log,
      memberCount: normalizedLogMembers.filter((entry) => entry.logId === log.id).length,
      clipCount: relatedClips.length,
      lastRecordedAtLabel: lastClip ? lastClip.recordedLocal : "",
      lastClipNote: lastClip ? lastClip.note || "没有备注" : "还没有片段"
    };
  });
  const selectedDateClips = annotatedClips.filter((clip) => clip.dateKey === dateKey);
  const todayKey = today();
  const todayClipCount = annotatedClips.filter((clip) => clip.dateKey === todayKey).length;
  const selectedLogClipCount = selectedLog ? annotatedClips.filter((clip) => clip.logId === selectedLog.id).length : 0;
  const selectedLogMemberCount = selectedLog
    ? normalizedLogMembers.filter((entry) => entry.logId === selectedLog.id).length
    : 0;
  const selectedDailyVlog = selectedUser
    ? normalizedDailyVlogs
        .filter((entry) => entry.userId === selectedUser.id && entry.dateKey === dateKey)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
    : null;

  return {
    users: normalizedUsers,
    logs: annotatedLogs,
    clips: annotatedClips,
    dailyVlogs: normalizedDailyVlogs,
    userIndex: safeUserIndex,
    logIndex: safeLogIndex,
    userNames: normalizedUsers.map((user) => user.name),
    logNames: normalizedLogs.map((log) => log.name),
    selectedUserName: selectedUser ? selectedUser.name : "",
    selectedLogName: selectedLog ? selectedLog.name : "",
    selectedDateClips,
    selectedDateClipCount: selectedDateClips.length,
    todayClipCount,
    totalClipCount: annotatedClips.length,
    selectedLogClipCount,
    selectedLogMemberCount,
    selectedDailyVlog,
    selectedDailyVlogStatusText: selectedDailyVlog
      ? selectedDailyVlog.status === "rendered"
        ? "已渲染完成"
        : "已生成计划"
      : "尚未生成",
    selectedDailyVlogOutputUrl: selectedDailyVlog ? selectedDailyVlog.outputUrl || "" : "",
    selectedDailyVlogClipCount: selectedDailyVlog && Array.isArray(selectedDailyVlog.clipIds) ? selectedDailyVlog.clipIds.length : 0
  };
}

Page({
  data: {
    users: [],
    logs: [],
    clips: [],
    dailyVlogs: [],
    logMembers: [],
    userIndex: 0,
    logIndex: 0,
    userNames: [],
    logNames: [],
    selectedUserName: "",
    selectedLogName: "",
    selectedDateClips: [],
    selectedDateClipCount: 0,
    todayClipCount: 0,
    totalClipCount: 0,
    selectedLogClipCount: 0,
    selectedLogMemberCount: 0,
    selectedDailyVlog: null,
    selectedDailyVlogStatusText: "尚未生成",
    selectedDailyVlogOutputUrl: "",
    selectedDailyVlogClipCount: 0,
    newLogName: "",
    note: "",
    recordedAt: isoNow(),
    dateKey: today(),
    statusText: "初始化中..."
  },

  onLoad() {
    this.refresh();
  },

  async refresh() {
    try {
      this.setData({ statusText: "加载中..." });
      const bootstrap = await api.request("/api/bootstrap");
      const users = bootstrap.users || [];
      const logs = bootstrap.logs || [];
      const logMembers = bootstrap.logMembers || [];
      const clips = (bootstrap.clips || []).map((clip) => ({
        ...clip,
        userName: this.lookupUserName(users, clip.userId),
        logName: this.lookupLogName(logs, clip.logId),
        recordedLocal: formatLocalDateTime(clip.recordedAt)
      }));
      const dailyVlogs = bootstrap.dailyVlogs || [];
      this.setData({
        users,
        logs,
        logMembers,
        clips,
        dailyVlogs,
        statusText: `已加载 ${users.length} 位用户，${logs.length} 个 log，${clips.length} 条片段。`
      }, () => {
        this.rebuildDerivedState();
      });
    } catch (error) {
      this.setData({
        statusText: `加载失败：${error.message}`
      });
    }
  },

  onUserChange(event) {
    const userIndex = Number(event.detail.value);
    this.setData({ userIndex }, () => {
      this.rebuildDerivedState();
    });
  },

  onLogChange(event) {
    const logIndex = Number(event.detail.value);
    this.setData({ logIndex }, () => {
      this.rebuildDerivedState();
    });
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  onNewLogNameInput(event) {
    this.setData({ newLogName: event.detail.value });
  },

  onDateChange(event) {
    this.setData({ dateKey: event.detail.value }, () => {
      this.rebuildDerivedState();
    });
  },

  async createLog() {
    const user = this.data.users[this.data.userIndex];
    if (!user) {
      this.setData({ statusText: "没有可用用户，无法创建 log。" });
      return;
    }
    const name = (this.data.newLogName || "").trim();
    if (!name) {
      this.setData({ statusText: "请输入 log 名称。" });
      return;
    }
    try {
      const result = await api.request("/api/logs", "POST", {
        name,
        ownerId: user.id
      });
      this.setData({
        statusText: `已创建 log：${result.data.name}`,
        newLogName: ""
      });
      await this.refresh();
    } catch (error) {
      this.setData({ statusText: `创建失败：${error.message}` });
    }
  },

  async recordAndUpload() {
    const user = this.data.users[this.data.userIndex];
    const log = this.data.logs[this.data.logIndex];
    if (!user || !log) {
      this.setData({ statusText: "请先选择用户和 log。" });
      return;
    }

    try {
      const chooseResult = await wx.chooseMedia({
        count: 1,
        mediaType: ["video"],
        sourceType: ["camera"],
        maxDuration: 2,
        camera: "back"
      });
      const file = chooseResult.tempFiles && chooseResult.tempFiles[0];
      if (!file || !file.tempFilePath) {
        throw new Error("没有拿到视频文件。");
      }

      const intent = await api.request("/api/upload-intents", "POST", {
        userId: user.id,
        logId: log.id,
        recordedAt: isoNow(),
        durationSeconds: 2,
        note: this.data.note,
        timeZone: getApp().globalData.timeZone
      });

      await api.uploadFile(intent.uploadUrl, file.tempFilePath);
      this.setData({
        recordedAt: isoNow(),
        note: "",
        statusText: `已上传：${intent.clipId}`
      }, () => {
        this.rebuildDerivedState();
      });
      await this.refresh();
    } catch (error) {
      this.setData({
        statusText: `上传失败：${error.message}`
      });
    }
  },

  async generateDailyVlog() {
    const user = this.data.users[this.data.userIndex];
    if (!user) {
      this.setData({ statusText: "没有可用用户，无法生成 vlog。" });
      return;
    }
    try {
      const result = await api.request("/api/daily-vlogs/generate", "POST", {
        userId: user.id,
        date: this.data.dateKey,
        timeZone: getApp().globalData.timeZone
      });
      this.setData({
        statusText: `已生成每日 vlog：${result.dailyVlog.id}，状态 ${result.dailyVlog.status}`
      });
      await this.refresh();
    } catch (error) {
      this.setData({
        statusText: `生成失败：${error.message}`
      });
    }
  },

  lookupUserName(users, userId) {
    const user = users.find((item) => item.id === userId);
    return user ? user.name : userId;
  },

  lookupLogName(logs, logId) {
    const log = logs.find((item) => item.id === logId);
    return log ? log.name : logId;
  },

  rebuildDerivedState() {
    const viewModel = buildViewModel({
      users: this.data.users,
      logs: this.data.logs,
      clips: this.data.clips,
      dailyVlogs: this.data.dailyVlogs,
      logMembers: this.data.logMembers,
      userIndex: this.data.userIndex,
      logIndex: this.data.logIndex,
      dateKey: this.data.dateKey
    });
    this.setData(viewModel);
  }
});

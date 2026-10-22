'use strict';
// 单机版：应用不连接任何外部服务（大模型 / 语义向量接口一律不调用）；设置页对应页签置灰。
// 唯一的网络用途是用户主动发送的“意见反馈”邮件（使用用户自己配置的发件邮箱）。
const OFFLINE_ONLY = true;
const OFFLINE_MSG = '当前为单机版（不联网）：大模型与语义向量接口暂不可用';
module.exports = { OFFLINE_ONLY, OFFLINE_MSG };

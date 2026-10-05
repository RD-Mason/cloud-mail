<template>
  <el-dialog
      v-model="visible"
      :title="t('forwardBackfill.title')"
      width="min(760px, 94vw)"
      :close-on-click-modal="false"
      append-to-body
  >
    <div v-loading="initializing" class="backfill-body">
      <el-alert :title="t('forwardBackfill.description')" type="info" show-icon :closable="false"/>
      <p class="backfill-note">{{ t('forwardBackfill.legacyNotice') }}</p>

      <el-form v-if="historyJobs.length" label-position="top" class="backfill-history">
        <el-form-item :label="t('forwardBackfill.history')">
          <el-select :model-value="job?.jobId" :disabled="busy || !visible" class="backfill-input" @change="selectJob">
            <el-option v-for="record in historyJobs" :key="record.jobId"
                       :value="record.jobId" :label="historyLabel(record)"/>
          </el-select>
        </el-form-item>
        <p class="backfill-note">{{ t('forwardBackfill.historyNotice') }}</p>
      </el-form>
      <el-alert v-if="historyError" :title="t('forwardBackfill.historyUnavailable')"
                :description="historyError" type="warning" show-icon :closable="false"/>
      <div v-if="historyError && !job" class="backfill-actions">
        <el-button :disabled="busy" @click="refreshStatus">{{ t('forwardBackfill.refreshStatus') }}</el-button>
      </div>

      <el-alert v-if="requestError" :title="t('forwardBackfill.operationStopped')"
                :description="requestError" type="error" show-icon :closable="false"/>
      <div v-if="mustRefresh" class="backfill-actions">
        <el-button :loading="actionBusy" :disabled="initializing || running" @click="refreshStatus">
          {{ t('forwardBackfill.refreshStatus') }}
        </el-button>
        <span class="backfill-note">{{ t('forwardBackfill.refreshBeforeContinue') }}</span>
      </div>

      <section v-if="job" class="backfill-section" aria-live="polite">
        <div class="backfill-heading">
          <strong>{{ t('forwardBackfill.taskProgress') }}</strong>
          <el-tag :type="jobTagType">{{ jobStatusLabel }}</el-tag>
        </div>
        <div class="backfill-targets">
          <span>{{ t('forwardBackfill.targets') }}</span>
          <el-tag v-for="target in job.targets || []" :key="target" type="info">{{ target }}</el-tag>
        </div>
        <div class="backfill-counts">
          <div><strong>{{ job.sent || 0 }}</strong><span>{{ t('forwardBackfill.sent') }}</span></div>
          <div><strong>{{ job.failed || 0 }}</strong><span>{{ t('forwardBackfill.failed') }}</span></div>
          <div><strong>{{ (job.pending || 0) + (job.processing || 0) }}</strong><span>{{ t('forwardBackfill.pending') }}</span></div>
          <div v-if="job.unknown"><strong>{{ job.unknown }}</strong><span>{{ t('forwardBackfill.needsReview') }}</span></div>
        </div>
        <el-progress :percentage="progress" :status="progressStatus"/>
        <p class="backfill-note">{{ t('forwardBackfill.deliveryProgress', {total: job.total || 0}) }}</p>
        <el-alert v-if="job.unknown" :title="t('forwardBackfill.unknownNotice')"
                  type="warning" show-icon :closable="false"/>
        <p v-if="hasUnfinishedJob" class="backfill-note">{{ t('forwardBackfill.pauseNotice') }}</p>
        <div class="backfill-actions">
          <el-button v-if="running" :disabled="stopRequested" @click="pause">
            {{ t(stopRequested ? 'forwardBackfill.pausing' : 'forwardBackfill.pause') }}
          </el-button>
          <el-button v-else-if="hasUnfinishedJob" type="primary"
                     :disabled="initializing || actionBusy || mustRefresh" @click="runBatches">
            {{ t('forwardBackfill.continue') }}
          </el-button>
          <el-button v-if="job.failed > 0" :disabled="busy || mustRefresh" @click="retryFailed">
            {{ t('forwardBackfill.retryFailed') }}
          </el-button>
          <el-button v-if="!mustRefresh" :disabled="busy" @click="refreshStatus">
            {{ t('forwardBackfill.refreshStatus') }}
          </el-button>
        </div>
        <el-table v-if="job.errors?.length" :data="job.errors" max-height="240" class="backfill-errors">
          <el-table-column :label="t('forwardBackfill.subject')" min-width="150">
            <template #default="scope">{{ scope.row.subject || t('forwardBackfill.noSubject') }}</template>
          </el-table-column>
          <el-table-column prop="target" :label="t('forwardBackfill.target')" min-width="160"/>
          <el-table-column prop="message" :label="t('forwardBackfill.errorDetails')" min-width="220"/>
        </el-table>
      </section>

      <section v-if="statusLoaded && !hasUnfinishedJob" class="backfill-section">
        <el-form label-position="top">
          <el-form-item :label="t('forwardBackfill.mailbox')">
            <el-select v-model="accountId" :disabled="busy" class="backfill-input">
              <el-option :value="0" :label="t('forwardBackfill.allOwnMailboxes')"/>
              <el-option v-for="account in accounts" :key="account.accountId"
                         :value="account.accountId" :label="account.email"/>
            </el-select>
          </el-form-item>
          <el-form-item :label="t('forwardBackfill.dateRange')">
            <el-date-picker v-model="dateRange" type="datetimerange" :disabled="busy"
                            :start-placeholder="t('forwardBackfill.startDate')"
                            :end-placeholder="t('forwardBackfill.endDate')"
                            :range-separator="t('forwardBackfill.to')"
                            class="backfill-input"/>
          </el-form-item>
        </el-form>
        <el-button :loading="actionBusy" :disabled="initializing || running || mustRefresh" @click="fetchPreview">
          {{ t('forwardBackfill.preview') }}
        </el-button>

        <div v-if="preview" class="backfill-preview">
          <p><strong>{{ t('forwardBackfill.previewCount', {total: preview.total, deliveries: preview.deliveryTotal}) }}</strong></p>
          <div class="backfill-targets">
            <span>{{ t('forwardBackfill.targets') }}</span>
            <el-tag v-for="target in preview.targets || []" :key="target">{{ target }}</el-tag>
            <span v-if="!preview.targets?.length">{{ t('forwardBackfill.noTargets') }}</span>
          </div>
          <p v-if="preview.alreadySent" class="backfill-note">{{ t('forwardBackfill.alreadySent', {count: preview.alreadySent}) }}</p>
          <p v-if="preview.reservedDeliveries" class="backfill-note">{{ t('forwardBackfill.reserved', {count: preview.reservedDeliveries}) }}</p>
          <p class="backfill-ready" :class="{'is-unavailable': !preview.sendReady}">
            {{ t(preview.sendReady ? 'forwardBackfill.sendReady' : 'forwardBackfill.sendNotReady') }}
          </p>
          <p v-if="preview.unavailableDomains?.length" class="backfill-note">
            {{ t('forwardBackfill.unavailableDomains', {domains: preview.unavailableDomains.join(', ')}) }}
          </p>
          <el-button type="primary" :loading="actionBusy" :disabled="!canStart" @click="start">
            {{ t('forwardBackfill.confirmStart') }}
          </el-button>
        </div>
      </section>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ t('forwardBackfill.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import {ElMessageBox} from 'element-plus';
import {useI18n} from 'vue-i18n';
import {
  forwardBackfillHistory,
  forwardBackfillStatus,
  previewForwardBackfill,
  processForwardBackfill,
  retryForwardBackfill,
  startForwardBackfill
} from '@/request/forward-backfill.js';

const props = defineProps({modelValue: Boolean});
const emit = defineEmits(['update:modelValue']);
const {t} = useI18n();
const visible = computed({get: () => props.modelValue, set: value => emit('update:modelValue', value)});
const accountId = ref(0);
const dateRange = ref(null);
const accounts = ref([]);
const preview = ref(null);
const previewCriteria = ref(null);
const job = ref(null);
const historyJobs = ref([]);
const historyError = ref('');
const initializing = ref(false);
const statusLoaded = ref(false);
const actionBusy = ref(false);
const running = ref(false);
const stopRequested = ref(false);
const requestError = ref('');
const mustRefresh = ref(false);
let mounted = true;
let session = 0;
let requestQueue = Promise.resolve();

const busy = computed(() => initializing.value || actionBusy.value || running.value);
const hasUnfinishedJob = computed(() => !!job.value && ((job.value.pending || 0) + (job.value.processing || 0) > 0));
const canStart = computed(() => !busy.value && !mustRefresh.value && statusLoaded.value &&
    !!preview.value?.sendReady && preview.value.deliveryTotal > 0 && preview.value.targets?.length > 0);
const progress = computed(() => {
  const total = job.value?.total || 0;
  const done = (job.value?.sent || 0) + (job.value?.failed || 0) + (job.value?.unknown || 0);
  return total ? Math.min(100, Math.round(done * 100 / total)) : 0;
});
const progressStatus = computed(() => hasUnfinishedJob.value ? undefined :
    ((job.value?.failed || job.value?.unknown) ? 'warning' : 'success'));
const jobStatusLabel = computed(() => {
  if (running.value) return t(stopRequested.value ? 'forwardBackfill.pausing' : 'forwardBackfill.sending');
  if (hasUnfinishedJob.value) return t('forwardBackfill.paused');
  if (job.value?.unknown || job.value?.status === 'needs_review') return t('forwardBackfill.needsReview');
  return t(job.value?.failed ? 'forwardBackfill.completedWithErrors' : 'forwardBackfill.completed');
});
const jobTagType = computed(() => (job.value?.unknown || job.value?.failed) ? 'warning' :
    (hasUnfinishedJob.value || running.value ? 'info' : 'success'));

function alive(currentSession) {
  return mounted && visible.value && currentSession === session;
}

// Every request from this dialog is serialized, including status reads after reopening.
function serialRequest(task) {
  const next = requestQueue.then(task);
  requestQueue = next.catch(() => {});
  return next;
}

function errorMessage(error) {
  return error?.response?.data?.message || error?.message || t('forwardBackfill.requestFailed');
}

function historyDate(record) {
  const value = String(record.createdAt || '');
  // D1 CURRENT_TIMESTAMP is UTC even though SQLite omits the timezone suffix.
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? value.replace(' ', 'T') + 'Z' : value);
}

function historyLabel(record) {
  const date = historyDate(record);
  const time = Number.isNaN(date.getTime()) ? t('forwardBackfill.unknownDate') : date.toLocaleString();
  return t('forwardBackfill.historyItem', {
    time, sent: record.sent || 0, failed: record.failed || 0,
    pending: (record.pending || 0) + (record.processing || 0), unknown: record.unknown || 0
  });
}

function updateHistory(snapshot) {
  if (!snapshot) return;
  const records = historyJobs.value.filter(record => record.jobId !== snapshot.jobId);
  records.push(snapshot);
  historyJobs.value = records.sort((left, right) =>
      (historyDate(right).getTime() || 0) - (historyDate(left).getTime() || 0)).slice(0, 20);
}

function acceptJob(snapshot) {
  job.value = snapshot;
  updateHistory(snapshot);
}

async function loadHistory(currentSession) {
  try {
    const result = await serialRequest(() => alive(currentSession) ? forwardBackfillHistory() : null);
    if (!alive(currentSession) || !result) return;
    historyJobs.value = (result.jobs || []).slice(0, 20);
    updateHistory(job.value);
    historyError.value = '';
  } catch (error) {
    // A history read failure does not make a confirmed send result uncertain.
    if (alive(currentSession)) historyError.value = errorMessage(error);
  }
}

function criteria() {
  const params = {accountId: accountId.value};
  if (dateRange.value?.length === 2) {
    params.startTime = new Date(dateRange.value[0]).toISOString();
    params.endTime = new Date(dateRange.value[1]).toISOString();
  }
  return params;
}

function acceptPreview(result, params) {
  accounts.value = result.accounts || [];
  preview.value = result;
  previewCriteria.value = params;
}

async function initialize(currentSession) {
  initializing.value = true;
  statusLoaded.value = false;
  requestError.value = '';
  preview.value = null;
  try {
    const latest = await serialRequest(() => alive(currentSession) ? forwardBackfillStatus() : null);
    if (!alive(currentSession)) return;
    acceptJob(latest);
    statusLoaded.value = true;
    mustRefresh.value = false;
    await loadHistory(currentSession);
    if (!alive(currentSession)) return;
    const params = criteria();
    const result = await serialRequest(() => alive(currentSession) ? previewForwardBackfill(params) : null);
    if (alive(currentSession) && result) acceptPreview(result, params);
  } catch (error) {
    if (!alive(currentSession)) return;
    requestError.value = errorMessage(error);
    mustRefresh.value = !statusLoaded.value;
  } finally {
    if (alive(currentSession)) initializing.value = false;
  }
}

async function fetchPreview() {
  if (busy.value || mustRefresh.value) return;
  const currentSession = session;
  const params = criteria();
  actionBusy.value = true;
  requestError.value = '';
  preview.value = null;
  try {
    const result = await serialRequest(() => alive(currentSession) ? previewForwardBackfill(params) : null);
    if (alive(currentSession) && result) acceptPreview(result, params);
  } catch (error) {
    if (alive(currentSession)) requestError.value = errorMessage(error);
  } finally {
    actionBusy.value = false;
  }
}

async function refreshStatus() {
  if (busy.value) return;
  const currentSession = session;
  actionBusy.value = true;
  requestError.value = '';
  try {
    const latest = await serialRequest(() => alive(currentSession) ? forwardBackfillStatus(job.value?.jobId) : null);
    if (!alive(currentSession)) return;
    acceptJob(latest);
    statusLoaded.value = true;
    mustRefresh.value = false;
    preview.value = null;
    await loadHistory(currentSession);
    // Refreshing progress never resumes sending.
  } catch (error) {
    if (alive(currentSession)) {
      requestError.value = errorMessage(error);
      mustRefresh.value = true;
    }
  } finally {
    actionBusy.value = false;
  }
}

async function selectJob(jobId) {
  if (busy.value || !visible.value || jobId === job.value?.jobId) return;
  const currentSession = session;
  actionBusy.value = true;
  requestError.value = '';
  preview.value = null;
  try {
    const snapshot = await serialRequest(() => alive(currentSession) ? forwardBackfillStatus(jobId) : null);
    if (!alive(currentSession)) return;
    acceptJob(snapshot);
    statusLoaded.value = true;
    mustRefresh.value = false;
    // Selecting an earlier task only reads its state; resuming still requires a click.
  } catch (error) {
    if (alive(currentSession)) {
      requestError.value = errorMessage(error);
      mustRefresh.value = true;
    }
  } finally {
    actionBusy.value = false;
  }
}

async function start() {
  if (!canStart.value) return;
  const currentSession = session;
  const params = {...previewCriteria.value, cutoffId: preview.value.cutoffId, targets: [...preview.value.targets]};
  actionBusy.value = true;
  requestError.value = '';
  let started = false;
  try {
    await ElMessageBox.confirm(
        t('forwardBackfill.confirmMessage', {total: preview.value.total, deliveries: preview.value.deliveryTotal, targets: params.targets.join(', ')}),
        t('forwardBackfill.confirmTitle'),
        {confirmButtonText: t('forwardBackfill.confirmStart'), cancelButtonText: t('forwardBackfill.cancel'), type: 'warning'}
    );
    if (!alive(currentSession)) return;
    // If creation succeeds but its response is lost, refresh must find the latest task.
    job.value = null;
    const snapshot = await serialRequest(() => alive(currentSession) ? startForwardBackfill(params) : null);
    if (!alive(currentSession) || !snapshot) return;
    acceptJob(snapshot);
    preview.value = null;
    started = true;
    await loadHistory(currentSession);
  } catch (error) {
    if (error !== 'cancel' && error !== 'close' && alive(currentSession)) {
      requestError.value = errorMessage(error);
      mustRefresh.value = true;
    }
  } finally {
    actionBusy.value = false;
  }
  if (started && alive(currentSession)) await runBatches();
}

function pause() {
  stopRequested.value = true;
}

async function runBatches() {
  if (busy.value || mustRefresh.value || !hasUnfinishedJob.value || !visible.value) return;
  const currentSession = session;
  running.value = true;
  stopRequested.value = false;
  requestError.value = '';
  try {
    while (alive(currentSession) && !stopRequested.value && hasUnfinishedJob.value) {
      const before = JSON.stringify([job.value.sent, job.value.failed, job.value.unknown, job.value.pending, job.value.processing]);
      const snapshot = await serialRequest(() => alive(currentSession) && !stopRequested.value ? processForwardBackfill(job.value.jobId) : null);
      if (!alive(currentSession) || !snapshot) break;
      acceptJob(snapshot);
      const after = JSON.stringify([snapshot.sent, snapshot.failed, snapshot.unknown, snapshot.pending, snapshot.processing]);
      if (hasUnfinishedJob.value && before === after) {
        requestError.value = t('forwardBackfill.batchInProgress');
        mustRefresh.value = true;
        break;
      }
      // Give rendering and Pause a chance between batches without a long fixed wait.
      if (hasUnfinishedJob.value && !stopRequested.value) await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (alive(currentSession)) {
      requestError.value = errorMessage(error);
      mustRefresh.value = true;
    }
  } finally {
    running.value = false;
  }
}

async function retryFailed() {
  if (busy.value || mustRefresh.value || !job.value?.failed) return;
  const currentSession = session;
  actionBusy.value = true;
  requestError.value = '';
  let retried = false;
  try {
    await ElMessageBox.confirm(
        t('forwardBackfill.retryMessage', {count: job.value.failed}),
        t('forwardBackfill.retryFailed'),
        {confirmButtonText: t('forwardBackfill.retryFailed'), cancelButtonText: t('forwardBackfill.cancel'), type: 'warning'}
    );
    if (!alive(currentSession)) return;
    const snapshot = await serialRequest(() => alive(currentSession) ? retryForwardBackfill(job.value.jobId) : null);
    if (!alive(currentSession) || !snapshot) return;
    acceptJob(snapshot);
    preview.value = null;
    retried = true;
  } catch (error) {
    if (error !== 'cancel' && error !== 'close' && alive(currentSession)) {
      requestError.value = errorMessage(error);
      mustRefresh.value = true;
    }
  } finally {
    actionBusy.value = false;
  }
  if (retried && alive(currentSession)) await runBatches();
}

watch([accountId, dateRange], () => {
  preview.value = null;
  previewCriteria.value = null;
}, {deep: true});

watch(() => props.modelValue, value => {
  session++;
  stopRequested.value = true;
  if (value) initialize(session);
});

onBeforeUnmount(() => {
  mounted = false;
  session++;
  stopRequested.value = true;
});
</script>

<style scoped>
.backfill-body { min-height: 160px; }
.backfill-history { margin-top: 16px; }
.backfill-body > .el-alert + .el-alert { margin-top: 12px; }
.backfill-section { border-top: 1px solid var(--el-border-color-light); margin-top: 20px; padding-top: 20px; }
.backfill-heading, .backfill-targets, .backfill-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.backfill-heading { justify-content: space-between; margin-bottom: 16px; }
.backfill-targets { margin: 12px 0; overflow-wrap: anywhere; }
.backfill-targets .el-tag { height: auto; min-height: 24px; white-space: normal; overflow-wrap: anywhere; }
.backfill-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px; margin: 18px 0; }
.backfill-counts > div { background: var(--el-fill-color-light); border-radius: 6px; padding: 12px; }
.backfill-counts strong, .backfill-counts span { display: block; }
.backfill-counts strong { font-size: 22px; margin-bottom: 4px; }
.backfill-counts span, .backfill-note { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.backfill-actions { margin-top: 14px; }
.backfill-actions .el-button + .el-button { margin-left: 0; }
.backfill-errors { margin-top: 16px; }
.backfill-input { width: 100%; }
.backfill-preview { background: var(--el-fill-color-light); border-radius: 8px; padding: 16px; margin-top: 16px; }
.backfill-preview p:first-child { margin-top: 0; }
.backfill-ready { color: var(--el-color-success); }
.backfill-ready.is-unavailable { color: var(--el-color-danger); }
@media (max-width: 520px) {
  .backfill-counts { grid-template-columns: repeat(2, 1fr); }
  .backfill-actions .el-button { max-width: 100%; white-space: normal; height: auto; min-height: 32px; }
}
</style>

<template>
  <div class="content-box" ref="contentBox">
    <iframe
        ref="frame"
        class="content-html"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        title="email"
        @load="onFrameLoad"
    ></iframe>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  html: {
    type: String,
    required: true
  }
})

/*
 * Mail bodies are attacker-controlled HTML, so they are rendered in an iframe
 * whose sandbox does NOT include allow-scripts: nothing in a message can run
 * script (<script>, on* handlers, javascript: URLs). allow-same-origin is only
 * there so this component can measure and scale the content; with scripting
 * disabled the message itself cannot use it. The worker's CSP header is
 * inherited by the srcdoc document as a second barrier, and sanitize() strips
 * active content before rendering as a third.
 */

const BASE_STYLE = `
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    overflow: hidden !important;
    background: #FFFFFF;
  }

  body {
    font-family: Inter, 'Helvetica Neue', Helvetica, 'PingFang SC',
                'Hiragino Sans GB', 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #13181D;
    word-break: break-word;
  }

  h1, h2, h3, h4 {
    font-size: 18px;
    font-weight: 700;
  }

  p {
    margin: 0;
  }

  a {
    text-decoration: none;
    color: #0E70DF;
  }

  .shadow-content {
    background: #FFFFFF;
    width: fit-content;
    height: fit-content;
    min-width: 100%;
  }

  img:not(table img) {
    max-width: 100%;
    height: auto !important;
  }
`

const REMOVE_SELECTOR = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'base', 'meta', 'portal', 'link:not([rel~="stylesheet" i])'
].join(',')

const URL_ATTRIBUTES = new Set([
  'href', 'xlink:href', 'src', 'action', 'formaction', 'background', 'poster',
  'lowsrc', 'dynsrc', 'data', 'codebase', 'cite', 'longdesc'
])

const contentBox = ref(null)
const frame = ref(null)

let renderId = 0
let attachedDoc = null
let resizeObserver = null
let lastWidth = 0
let fitFrame = 0

function isUnsafeUrl(name, value) {
  // Browsers ignore whitespace and control characters inside the scheme ("java\tscript:").
  const url = value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()
  if (/^(javascript|vbscript|livescript):/.test(url)) return true
  if (url.startsWith('data:')) {
    return !(url.startsWith('data:image/') && !name.endsWith('href'))
  }
  return false
}

function sanitize(doc) {
  doc.querySelectorAll(REMOVE_SELECTOR).forEach(el => el.remove())

  doc.querySelectorAll('animate, set').forEach(el => {
    if (/href/i.test(el.getAttribute('attributeName') || '')) el.remove()
  })

  for (const el of doc.querySelectorAll('*')) {
    for (const {name, value} of Array.from(el.attributes)) {
      const lower = name.toLowerCase()
      if (lower.startsWith('on') || lower === 'srcdoc' || lower === 'ping') {
        el.removeAttribute(name)
      } else if (URL_ATTRIBUTES.has(lower) && isUnsafeUrl(lower, value)) {
        el.removeAttribute(name)
      }
    }
  }

  for (const link of doc.querySelectorAll('a[href], area[href]')) {
    if (link.getAttribute('href').trim().startsWith('#')) {
      link.setAttribute('target', '_self')
    } else {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    }
  }
}

function buildDocument(html, id) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  sanitize(doc)

  const body = doc.body || doc.documentElement.appendChild(doc.createElement('body'))
  const wrapper = doc.createElement('div')
  wrapper.className = 'shadow-content'
  wrapper.setAttribute('data-render-id', String(id))

  // The message's <body style> applies to the content wrapper, as before.
  const bodyStyle = body.getAttribute('style')
  if (bodyStyle) {
    wrapper.setAttribute('style', bodyStyle)
    body.removeAttribute('style')
  }
  wrapper.append(...body.childNodes)
  body.append(wrapper)

  const referrer = doc.createElement('meta')
  referrer.setAttribute('name', 'referrer')
  referrer.setAttribute('content', 'no-referrer')
  const base = doc.createElement('base')
  base.setAttribute('target', '_blank')
  const style = doc.createElement('style')
  style.textContent = BASE_STYLE
  doc.head.prepend(referrer, base, style)

  return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}

function frameDocument() {
  try {
    return frame.value?.contentDocument || null
  } catch {
    return null
  }
}

function contentRoot(doc) {
  return doc?.querySelector('body > .shadow-content[data-render-id]') || null
}

// Scale wide messages down to the available width (as before) and size the frame to the content.
function fit() {
  const el = frame.value
  const root = contentRoot(frameDocument())
  if (!el || !root) return

  const available = el.clientWidth
  if (!available) return

  root.style.zoom = ''
  const natural = root.scrollWidth
  if (natural > available) {
    root.style.zoom = String(available / natural)
  }
  el.style.height = `${Math.ceil(root.getBoundingClientRect().height)}px`
}

function scheduleFit() {
  if (fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fit()
  })
}

function attach(doc) {
  if (!doc || doc === attachedDoc) return
  attachedDoc = doc
  // Images and fonts change the content size after the first layout.
  doc.addEventListener('load', scheduleFit, true)
  doc.addEventListener('error', scheduleFit, true)
  doc.fonts?.ready?.then(scheduleFit).catch(() => {})
}

function waitForDocument(id) {
  let tries = 0
  const tick = () => {
    if (id !== renderId) return
    const doc = frameDocument()
    const root = contentRoot(doc)
    if (root && root.getAttribute('data-render-id') === String(id) && doc.readyState !== 'loading') {
      attach(doc)
      fit()
      return
    }
    if (++tries < 600) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function onFrameLoad() {
  const doc = frameDocument()
  if (!contentRoot(doc)) return
  attach(doc)
  fit()
}

function render() {
  const el = frame.value
  if (!el) return
  const id = ++renderId
  el.srcdoc = buildDocument(props.html || '', id)
  waitForDocument(id)
}

onMounted(() => {
  resizeObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width || 0
    if (width !== lastWidth) {
      lastWidth = width
      scheduleFit()
    }
  })
  resizeObserver.observe(contentBox.value)
  render()
})

onBeforeUnmount(() => {
  renderId++
  resizeObserver?.disconnect()
  if (fitFrame) cancelAnimationFrame(fitFrame)
})

watch(() => props.html, () => {
  render()
})
</script>

<style scoped>
.content-box {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: Inter, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", Arial, sans-serif;
}

.content-html {
  display: block;
  width: 100%;
  border: 0;
}
</style>

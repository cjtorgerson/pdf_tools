document.addEventListener("DOMContentLoaded", () => {
  const elements = {
    fileInput: document.getElementById("file-input"),
    exportButton: document.getElementById("export-btn"),
    clearButton: document.getElementById("clear-btn"),
    dropZone: document.getElementById("drop-zone"),
    pages: document.getElementById("pages"),
    emptyState: document.getElementById("empty-state"),
    summary: document.getElementById("summary"),
    status: document.getElementById("status"),
    messages: document.getElementById("message-list"),
  }

  const state = {
    pages: [],
    sources: new Map(),
    messages: [],
    nextPageId: 1,
    nextSourceId: 1,
    dragPageId: null,
    editingPageId: null,
    isImporting: false,
    isExporting: false,
    autoScrollFrameId: null,
    autoScrollSpeed: 0,
    statusText: "Ready for import",
  }

  const hasPdfLib = Boolean(window.PDFLib && window.PDFLib.PDFDocument)
  const hasPdfJs = Boolean(window.pdfjsLib)

  if (hasPdfJs) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js"
  }

  bindEvents()

  if (!hasPdfLib || !hasPdfJs) {
    pushMessage(
      "error",
      "Missing local PDF libraries. Ensure vendor/pdf-lib.min.js, vendor/pdf.min.js, and vendor/pdf.worker.min.js are present."
    )
    elements.fileInput.disabled = true
  }

  render()

  function bindEvents() {
    elements.fileInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || [])
      event.target.value = ""
      if (files.length > 0) {
        await importFiles(files)
      }
    })

    elements.exportButton.addEventListener("click", exportCombinedPdf)
    elements.clearButton.addEventListener("click", clearAll)

    elements.dropZone.addEventListener("click", () => {
      if (!elements.fileInput.disabled) {
        elements.fileInput.click()
      }
    })

    elements.dropZone.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !elements.fileInput.disabled) {
        event.preventDefault()
        elements.fileInput.click()
      }
    })

    ;["dragenter", "dragover"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (event) => {
        if (hasFiles(event)) {
          event.preventDefault()
          elements.dropZone.classList.add("is-active")
        }
      })
    })

    ;["dragleave", "drop"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, () => {
        elements.dropZone.classList.remove("is-active")
      })
    })

    elements.dropZone.addEventListener("drop", async (event) => {
      if (!hasFiles(event)) {
        return
      }

      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files || [])
      if (files.length > 0) {
        await importFiles(files)
      }
    })

    window.addEventListener("dragover", (event) => {
      if (hasFiles(event)) {
        event.preventDefault()
      }
    })

    window.addEventListener("drop", (event) => {
      if (hasFiles(event)) {
        event.preventDefault()
      }
    })

    elements.pages.addEventListener("click", (event) => {
      const deleteButton = event.target.closest("[data-action='delete-page']")
      if (deleteButton) {
        const pageId = Number(deleteButton.closest("[data-page-id]")?.dataset.pageId)
        deletePage(pageId)
        return
      }

      const editOrderButton = event.target.closest("[data-action='edit-order']")
      if (!editOrderButton) {
        return
      }

      const pageId = Number(editOrderButton.closest("[data-page-id]")?.dataset.pageId)
      beginOrderEdit(pageId)
    })

    elements.pages.addEventListener("dragstart", (event) => {
      if (event.target.closest("[data-prevent-card-drag='true']")) {
        event.preventDefault()
        return
      }

      const card = event.target.closest("[data-page-id]")
      if (!card) {
        return
      }

      state.editingPageId = null
      state.dragPageId = Number(card.dataset.pageId)
      card.classList.add("dragging")
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", String(state.dragPageId))
      }
    })

    elements.pages.addEventListener("dragend", () => {
      finishDrag()
    })

    elements.pages.addEventListener("dragover", (event) => {
      if (state.dragPageId == null) {
        return
      }

      event.preventDefault()
      updateAutoScroll(event.clientY)
      const card = event.target.closest("[data-page-id]")
      clearDropMarkers()

      if (!card) {
        return
      }

      const placement = getPlacement(card, event)
      card.classList.add(placement === "before" ? "drop-before" : "drop-after")
    })

    elements.pages.addEventListener("drop", (event) => {
      if (state.dragPageId == null) {
        return
      }

      event.preventDefault()
      const card = event.target.closest("[data-page-id]")

      if (!card) {
        movePageToEnd(state.dragPageId)
        finishDrag()
        return
      }

      const targetId = Number(card.dataset.pageId)
      const placement = getPlacement(card, event)
      movePage(state.dragPageId, targetId, placement)
      finishDrag()
    })

    elements.pages.addEventListener("keydown", (event) => {
      const orderInput = event.target.closest("[data-action='commit-order']")
      if (!orderInput) {
        return
      }

      if (event.key === "Enter") {
        event.preventDefault()
        commitOrderEdit(Number(orderInput.dataset.pageId), orderInput.value)
      } else if (event.key === "Escape") {
        event.preventDefault()
        cancelOrderEdit()
      }
    })

    elements.pages.addEventListener("focusout", (event) => {
      const orderInput = event.target.closest("[data-action='commit-order']")
      if (!orderInput) {
        return
      }

      commitOrderEdit(Number(orderInput.dataset.pageId), orderInput.value)
    })

    document.addEventListener("dragover", (event) => {
      if (state.dragPageId == null) {
        return
      }

      updateAutoScroll(event.clientY)
    })
  }

  async function importFiles(files) {
    if (!hasPdfLib || !hasPdfJs || state.isImporting || state.isExporting) {
      return
    }

    state.isImporting = true
    state.statusText = `Importing ${files.length} file${files.length === 1 ? "" : "s"}...`
    render()

    for (const file of files) {
      await importSingleFile(file)
    }

    state.isImporting = false
    state.statusText = state.pages.length > 0 ? "Ready to reorder and export" : "Ready for import"
    render()
  }

  async function importSingleFile(file) {
    if (!looksLikePdf(file)) {
      pushMessage("error", `${file.name} is not a PDF.`)
      return
    }

    let sourceBytes
    let validationBytes
    let previewBytes
    try {
      const fileBuffer = await file.arrayBuffer()

      // PDF.js may transfer its input into a worker, so export needs an untouched copy.
      sourceBytes = new Uint8Array(fileBuffer.slice(0))
      validationBytes = sourceBytes.slice()
      previewBytes = sourceBytes.slice()
    } catch (error) {
      pushMessage("error", `Could not read ${file.name}.`)
      return
    }

    try {
      await window.PDFLib.PDFDocument.load(validationBytes, { ignoreEncryption: false })
    } catch (error) {
      if (isPasswordError(error)) {
        pushMessage("error", `${file.name} is password-protected and cannot be imported in this version.`)
      } else {
        pushMessage("error", `${file.name} could not be parsed as a valid PDF.`)
      }
      return
    }

    let previewDocument
    try {
      previewDocument = await window.pdfjsLib.getDocument({
        data: previewBytes,
      }).promise
    } catch (error) {
      if (isPasswordError(error)) {
        pushMessage("error", `${file.name} is password-protected and cannot be imported in this version.`)
      } else {
        pushMessage("error", `${file.name} could not be rendered for preview.`)
      }
      return
    }

    const sourceId = state.nextSourceId++
    state.sources.set(sourceId, {
      id: sourceId,
      name: file.name,
      bytes: sourceBytes,
      pageCount: previewDocument.numPages,
    })

    for (let pageNumber = 1; pageNumber <= previewDocument.numPages; pageNumber += 1) {
      const thumbnailUrl = await renderThumbnail(previewDocument, pageNumber)
      state.pages.push({
        id: state.nextPageId++,
        sourceId,
        sourceName: file.name,
        sourcePageIndex: pageNumber - 1,
        sourcePageNumber: pageNumber,
        thumbnailUrl,
      })
      render()
    }

    if (typeof previewDocument.cleanup === "function") {
      previewDocument.cleanup()
    }
    if (typeof previewDocument.destroy === "function") {
      previewDocument.destroy()
    }

    pushMessage("info", `Imported ${file.name} (${previewDocument.numPages} page${previewDocument.numPages === 1 ? "" : "s"}).`)
  }

  async function renderThumbnail(previewDocument, pageNumber) {
    const page = await previewDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const targetWidth = 150
    const scale = targetWidth / viewport.width
    const scaledViewport = page.getViewport({ scale })
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d", { alpha: false })
    canvas.width = Math.ceil(scaledViewport.width)
    canvas.height = Math.ceil(scaledViewport.height)

    await page.render({
      canvasContext: context,
      viewport: scaledViewport,
    }).promise

    return canvas.toDataURL("image/png")
  }

  function deletePage(pageId) {
    const index = state.pages.findIndex((page) => page.id === pageId)
    if (index === -1) {
      return
    }

    const [removed] = state.pages.splice(index, 1)
    pruneUnusedSources()
    pushMessage("info", `Removed page ${removed.sourcePageNumber} from ${removed.sourceName}.`)
    state.statusText = state.pages.length > 0 ? "Ready to reorder and export" : "Ready for import"
    render()
  }

  function movePage(dragPageId, targetPageId, placement) {
    if (dragPageId === targetPageId) {
      return
    }

    const fromIndex = state.pages.findIndex((page) => page.id === dragPageId)
    const targetIndex = state.pages.findIndex((page) => page.id === targetPageId)
    if (fromIndex === -1 || targetIndex === -1) {
      return
    }

    const [moved] = state.pages.splice(fromIndex, 1)
    let insertIndex = state.pages.findIndex((page) => page.id === targetPageId)
    if (insertIndex === -1) {
      state.pages.push(moved)
      return
    }

    if (placement === "after") {
      insertIndex += 1
    }

    state.pages.splice(insertIndex, 0, moved)
    state.statusText = "Page order updated"
  }

  function movePageToEnd(pageId) {
    const fromIndex = state.pages.findIndex((page) => page.id === pageId)
    if (fromIndex === -1 || fromIndex === state.pages.length - 1) {
      return
    }

    const [moved] = state.pages.splice(fromIndex, 1)
    state.pages.push(moved)
    state.statusText = "Page moved to the end"
  }

  function movePageToPosition(pageId, rawPosition) {
    const fromIndex = state.pages.findIndex((page) => page.id === pageId)
    if (fromIndex === -1) {
      return
    }

    const requestedPosition = Number.parseInt(String(rawPosition), 10)
    if (!Number.isFinite(requestedPosition)) {
      state.statusText = "Page move canceled"
      render()
      return
    }

    const targetPosition = clamp(requestedPosition, 1, state.pages.length)
    if (targetPosition === fromIndex + 1) {
      state.statusText = "Page position unchanged"
      render()
      revealPageCard(pageId)
      return
    }

    const [moved] = state.pages.splice(fromIndex, 1)
    state.pages.splice(targetPosition - 1, 0, moved)
    state.statusText = `Moved page to position ${targetPosition}`
    render()
    revealPageCard(pageId)
  }

  async function exportCombinedPdf() {
    if (state.pages.length === 0 || state.isImporting || state.isExporting || !hasPdfLib) {
      return
    }

    state.isExporting = true
    state.statusText = "Building combined PDF..."
    render()

    try {
      const outputDocument = await window.PDFLib.PDFDocument.create()
      const sourceCache = new Map()

      for (const page of state.pages) {
        let sourceDocument = sourceCache.get(page.sourceId)
        if (!sourceDocument) {
          const source = state.sources.get(page.sourceId)
          sourceDocument = await window.PDFLib.PDFDocument.load(source.bytes.slice(), {
            ignoreEncryption: false,
          })
          sourceCache.set(page.sourceId, sourceDocument)
        }

        const [copiedPage] = await outputDocument.copyPages(sourceDocument, [page.sourcePageIndex])
        outputDocument.addPage(copiedPage)
      }

      const outputBytes = await outputDocument.save()
      downloadBytes(outputBytes, "combined.pdf", "application/pdf")
      pushMessage("info", `Exported combined.pdf with ${state.pages.length} page${state.pages.length === 1 ? "" : "s"}.`)
      state.statusText = "Combined PDF downloaded"
    } catch (error) {
      console.error(error)
      pushMessage("error", "The combined PDF could not be exported.")
      state.statusText = "Export failed"
    } finally {
      state.isExporting = false
      render()
    }
  }

  function clearAll() {
    state.pages = []
    state.sources.clear()
    state.messages = []
    state.dragPageId = null
    state.editingPageId = null
    stopAutoScroll()
    state.statusText = "Ready for import"
    render()
  }

  function render() {
    renderSummary()
    renderStatus()
    renderMessages()
    renderPages()
    renderButtons()
  }

  function renderSummary() {
    const fileCount = getActiveSourceCount()
    const pageCount = state.pages.length

    if (pageCount === 0) {
      elements.summary.textContent = "No files loaded"
      return
    }

    elements.summary.textContent = `${fileCount} file${fileCount === 1 ? "" : "s"} | ${pageCount} page${pageCount === 1 ? "" : "s"}`
  }

  function renderStatus() {
    elements.status.textContent = state.statusText
  }

  function renderMessages() {
    elements.messages.replaceChildren()

    for (const message of state.messages) {
      const messageElement = document.createElement("div")
      messageElement.className = `message ${message.kind}`
      messageElement.textContent = message.text
      elements.messages.append(messageElement)
    }
  }

  function renderPages() {
    const hasPages = state.pages.length > 0
    elements.emptyState.hidden = hasPages
    elements.pages.classList.toggle("is-empty", !hasPages)
    elements.pages.replaceChildren()

    if (!hasPages) {
      return
    }

    state.pages.forEach((page, index) => {
      const card = document.createElement("article")
      card.className = "page-card"
      card.draggable = true
      card.dataset.pageId = String(page.id)

      if (state.dragPageId === page.id) {
        card.classList.add("dragging")
      }

      const header = document.createElement("div")
      header.className = "page-card-header"

      let order
      if (state.editingPageId === page.id) {
        order = document.createElement("input")
        order.type = "number"
        order.min = "1"
        order.max = String(state.pages.length)
        order.value = String(index + 1)
        order.className = "page-order page-order-input"
        order.dataset.action = "commit-order"
        order.dataset.pageId = String(page.id)
        order.dataset.preventCardDrag = "true"
        order.inputMode = "numeric"
        order.setAttribute("aria-label", `Enter a new position for ${page.sourceName}`)
      } else {
        order = document.createElement("button")
        order.type = "button"
        order.className = "page-order page-order-button"
        order.dataset.action = "edit-order"
        order.dataset.preventCardDrag = "true"
        order.textContent = String(index + 1)
        order.setAttribute("aria-label", `Edit the position for ${page.sourceName}`)
        order.title = "Click to move this page by number"
      }

      const deleteButton = document.createElement("button")
      deleteButton.type = "button"
      deleteButton.className = "button delete-button"
      deleteButton.dataset.action = "delete-page"
      deleteButton.dataset.preventCardDrag = "true"
      deleteButton.textContent = "Delete"
      deleteButton.setAttribute("aria-label", `Delete page ${page.sourcePageNumber} from ${page.sourceName}`)

      header.append(order, deleteButton)

      const preview = document.createElement("div")
      preview.className = "page-preview"

      const image = document.createElement("img")
      image.src = page.thumbnailUrl
      image.alt = `${page.sourceName}, page ${page.sourcePageNumber}`
      preview.append(image)

      const meta = document.createElement("div")
      meta.className = "page-meta"

      const title = document.createElement("p")
      title.className = "page-title"
      title.textContent = page.sourceName

      const source = document.createElement("p")
      source.className = "page-source"
      source.textContent = `Original page ${page.sourcePageNumber}`

      meta.append(title, source)
      card.append(header, preview, meta)
      elements.pages.append(card)
    })

    if (state.editingPageId != null) {
      requestAnimationFrame(() => {
        const activeEditor = elements.pages.querySelector("[data-action='commit-order']")
        if (!activeEditor) {
          return
        }

        activeEditor.focus()
        activeEditor.select()
      })
    }
  }

  function renderButtons() {
    const canEdit = state.pages.length > 0 && !state.isImporting && !state.isExporting
    elements.exportButton.disabled = !canEdit
    elements.clearButton.disabled = state.pages.length === 0 && state.messages.length === 0
  }

  function pushMessage(kind, text) {
    state.messages.unshift({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      kind,
      text,
    })
    state.messages = state.messages.slice(0, 8)
    renderMessages()
  }

  function downloadBytes(bytes, fileName, mimeType) {
    const blob = new Blob([bytes], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileName
    anchor.style.display = "none"
    document.body.append(anchor)
    anchor.click()
    setTimeout(() => {
      anchor.remove()
      URL.revokeObjectURL(url)
    }, 1000)
  }

  function clearDropMarkers() {
    elements.pages.querySelectorAll(".drop-before, .drop-after").forEach((card) => {
      card.classList.remove("drop-before", "drop-after")
    })
  }

  function finishDrag() {
    state.dragPageId = null
    clearDropMarkers()
    stopAutoScroll()
    render()
  }

  function beginOrderEdit(pageId) {
    if (!Number.isFinite(pageId)) {
      return
    }

    state.editingPageId = pageId
    render()
  }

  function cancelOrderEdit() {
    if (state.editingPageId == null) {
      return
    }

    state.editingPageId = null
    state.statusText = "Page move canceled"
    render()
  }

  function commitOrderEdit(pageId, rawValue) {
    if (state.editingPageId !== pageId) {
      return
    }

    state.editingPageId = null
    movePageToPosition(pageId, rawValue)
  }

  function getPlacement(card, event) {
    const rect = card.getBoundingClientRect()
    const useVerticalSplit = rect.height >= rect.width
    if (useVerticalSplit) {
      return event.clientY < rect.top + rect.height / 2 ? "before" : "after"
    }
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after"
  }

  function looksLikePdf(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name)
  }

  function revealPageCard(pageId) {
    requestAnimationFrame(() => {
      const pageCard = elements.pages.querySelector(`[data-page-id='${pageId}']`)
      if (!pageCard) {
        return
      }

      pageCard.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      })
    })
  }

  function updateAutoScroll(pointerY) {
    const edgeThreshold = 110
    const distanceFromBottom = window.innerHeight - pointerY
    let nextSpeed = 0

    if (pointerY < edgeThreshold) {
      nextSpeed = -Math.ceil((edgeThreshold - pointerY) / 10)
    } else if (distanceFromBottom < edgeThreshold) {
      nextSpeed = Math.ceil((edgeThreshold - distanceFromBottom) / 10)
    }

    state.autoScrollSpeed = nextSpeed

    if (nextSpeed !== 0 && state.autoScrollFrameId == null) {
      state.autoScrollFrameId = window.requestAnimationFrame(runAutoScrollFrame)
    }
  }

  function runAutoScrollFrame() {
    if (state.dragPageId == null) {
      stopAutoScroll()
      return
    }

    if (state.autoScrollSpeed !== 0) {
      window.scrollBy(0, state.autoScrollSpeed)
    }

    state.autoScrollFrameId = window.requestAnimationFrame(runAutoScrollFrame)
  }

  function stopAutoScroll() {
    if (state.autoScrollFrameId != null) {
      window.cancelAnimationFrame(state.autoScrollFrameId)
      state.autoScrollFrameId = null
    }

    state.autoScrollSpeed = 0
  }

  function getActiveSourceCount() {
    return new Set(state.pages.map((page) => page.sourceId)).size
  }

  function pruneUnusedSources() {
    const activeSourceIds = new Set(state.pages.map((page) => page.sourceId))
    for (const sourceId of state.sources.keys()) {
      if (!activeSourceIds.has(sourceId)) {
        state.sources.delete(sourceId)
      }
    }
  }

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files")
  }

  function isPasswordError(error) {
    const message = String(error?.message || "")
    return error?.name === "PasswordException" || /password|encrypted|encryption/i.test(message)
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max)
  }
})

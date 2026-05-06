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
    previewModal: document.getElementById("preview-modal"),
    previewClose: document.getElementById("preview-close"),
    previewKicker: document.getElementById("preview-kicker"),
    previewTitle: document.getElementById("preview-title"),
    previewStage: document.getElementById("preview-stage"),
  }

  const pageElements = new Map()
  const pageRefs = new Map()
  const thumbnailQueue = []
  const queuedThumbnailIds = new Set()
  let activeThumbnailJobs = 0

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
    previewPageId: null,
    previewRenderToken: 0,
    statusText: "Ready for import",
  }

  const THUMBNAIL_WIDTH = 150
  const THUMBNAIL_CONCURRENCY = 2
  const hasPdfLib = Boolean(window.PDFLib && window.PDFLib.PDFDocument)
  const hasPdfJs = Boolean(window.pdfjsLib)
  const thumbnailObserver = hasPdfJs
    ? new IntersectionObserver(handleThumbnailIntersection, {
        root: null,
        rootMargin: "320px 0px",
      })
    : null

  if (hasPdfJs) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js"
  }

  bindEvents()

  if (!hasPdfLib || !hasPdfJs) {
    pushMessage(
      "error",
      "Missing local PDF libraries. Ensure vendor/pdf-lib.min.js, vendor/pdf.min.js, and vendor/pdf.worker.min.js are present."
    )
  }

  renderSummary()
  renderStatus()
  renderMessages()
  renderButtons()
  renderEmptyState()

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
    elements.previewClose.addEventListener("click", closePreview)

    elements.previewModal.addEventListener("click", (event) => {
      if (event.target === elements.previewModal) {
        closePreview()
      }
    })

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.previewModal.hidden) {
        closePreview()
      }
    })

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
        if (hasFiles(event) && canImportFiles()) {
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
      if (!hasFiles(event) || !canImportFiles()) {
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
      if (isBusy()) {
        return
      }

      const deleteButton = event.target.closest("[data-action='delete-page']")
      if (deleteButton) {
        const pageId = Number(deleteButton.closest("[data-page-id]")?.dataset.pageId)
        deletePage(pageId)
        return
      }

      const editOrderButton = event.target.closest("[data-action='edit-order']")
      if (editOrderButton) {
        const pageId = Number(editOrderButton.closest("[data-page-id]")?.dataset.pageId)
        beginOrderEdit(pageId)
        return
      }

      const previewButton = event.target.closest("[data-action='open-preview']")
      if (!previewButton) {
        return
      }

      const pageId = Number(previewButton.closest("[data-page-id]")?.dataset.pageId)
      openPreview(pageId)
    })

    elements.pages.addEventListener("dragstart", (event) => {
      if (isBusy() || event.target.closest("[data-prevent-card-drag='true']")) {
        event.preventDefault()
        return
      }

      const card = event.target.closest("[data-page-id]")
      if (!card) {
        return
      }

      state.editingPageId = null
      state.dragPageId = Number(card.dataset.pageId)
      refreshPageCards()

      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", String(state.dragPageId))
      }
    })

    elements.pages.addEventListener("dragend", () => {
      finishDrag()
    })

    elements.pages.addEventListener("dragover", (event) => {
      if (state.dragPageId == null || isBusy()) {
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
      if (state.dragPageId == null || isBusy()) {
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
    if (!canImportFiles()) {
      return
    }

    state.isImporting = true
    renderButtons()
    refreshPageInteractivity()

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      setStatus(`Importing ${index + 1} of ${files.length}: ${file.name}`)
      await importSingleFile(file, index + 1, files.length)
    }

    state.isImporting = false
    setStatus(state.pages.length > 0 ? "Ready to reorder and export" : "Ready for import")
    renderButtons()
    refreshPageInteractivity()
  }

  async function importSingleFile(file, fileNumber, totalFiles) {
    if (!looksLikePdf(file)) {
      pushMessage("error", `${file.name} is not a PDF.`)
      return
    }

    let sourceBytes
    try {
      const fileBuffer = await file.arrayBuffer()
      sourceBytes = new Uint8Array(fileBuffer.slice(0))
    } catch (error) {
      pushMessage("error", `Could not read ${file.name}.`)
      return
    }

    try {
      await window.PDFLib.PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: false })
    } catch (error) {
      if (isPasswordError(error)) {
        pushMessage("error", `${file.name} is password-protected and cannot be imported in this version.`)
      } else {
        pushMessage("error", `${file.name} could not be parsed as a valid PDF.`)
      }
      return
    }

    const sourceId = state.nextSourceId++
    const source = {
      id: sourceId,
      name: file.name,
      bytes: sourceBytes,
      pageCount: 0,
      pdfjsDocument: null,
      pdfjsDocumentPromise: null,
    }
    state.sources.set(sourceId, source)

    let pdfjsDocument
    try {
      pdfjsDocument = await getSourcePdfJsDocument(source)
    } catch (error) {
      cleanupSource(sourceId)
      if (isPasswordError(error)) {
        pushMessage("error", `${file.name} is password-protected and cannot be imported in this version.`)
      } else {
        pushMessage("error", `${file.name} could not be rendered for preview.`)
      }
      return
    }

    source.pageCount = pdfjsDocument.numPages
    addImportedPages(source, source.pageCount)
    setStatus(`Imported ${fileNumber} of ${totalFiles}: ${file.name} (${source.pageCount} pages). Thumbnails load as pages come into view.`)
    pushMessage("info", `Imported ${file.name} (${source.pageCount} page${source.pageCount === 1 ? "" : "s"}).`)
  }

  function addImportedPages(source, pageCount) {
    const newPages = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      newPages.push({
        id: state.nextPageId++,
        sourceId: source.id,
        sourceName: source.name,
        sourcePageIndex: pageNumber - 1,
        sourcePageNumber: pageNumber,
        thumbnailStatus: "idle",
        thumbnailUrl: null,
      })
    }

    state.pages.push(...newPages)
    syncPageGrid()
    renderSummary()
    renderButtons()
  }

  function deletePage(pageId) {
    const index = state.pages.findIndex((page) => page.id === pageId)
    if (index === -1) {
      return
    }

    const [removed] = state.pages.splice(index, 1)
    cleanupThumbnailForPage(removed)
    removePageCard(pageId)

    if (state.previewPageId === pageId) {
      closePreview()
    }
    if (state.editingPageId === pageId) {
      state.editingPageId = null
    }

    pruneUnusedSources()
    syncPageGrid()
    renderSummary()
    renderButtons()
    setStatus(state.pages.length > 0 ? "Ready to reorder and export" : "Ready for import")
    pushMessage("info", `Removed page ${removed.sourcePageNumber} from ${removed.sourceName}.`)
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
      syncPageGrid()
      setStatus("Page order updated")
      return
    }

    if (placement === "after") {
      insertIndex += 1
    }

    state.pages.splice(insertIndex, 0, moved)
    syncPageGrid()
    setStatus("Page order updated")
  }

  function movePageToEnd(pageId) {
    const fromIndex = state.pages.findIndex((page) => page.id === pageId)
    if (fromIndex === -1 || fromIndex === state.pages.length - 1) {
      return
    }

    const [moved] = state.pages.splice(fromIndex, 1)
    state.pages.push(moved)
    syncPageGrid()
    setStatus("Page moved to the end")
  }

  function movePageToPosition(pageId, rawPosition) {
    const fromIndex = state.pages.findIndex((page) => page.id === pageId)
    if (fromIndex === -1) {
      return
    }

    const requestedPosition = Number.parseInt(String(rawPosition), 10)
    if (!Number.isFinite(requestedPosition)) {
      setStatus("Page move canceled")
      refreshPageCards()
      return
    }

    const targetPosition = clamp(requestedPosition, 1, state.pages.length)
    if (targetPosition === fromIndex + 1) {
      setStatus("Page position unchanged")
      refreshPageCards()
      revealPageCard(pageId)
      return
    }

    const [moved] = state.pages.splice(fromIndex, 1)
    state.pages.splice(targetPosition - 1, 0, moved)
    syncPageGrid()
    setStatus(`Moved page to position ${targetPosition}`)
    revealPageCard(pageId)
  }

  async function exportCombinedPdf() {
    if (state.pages.length === 0 || isBusy() || !hasPdfLib) {
      return
    }

    state.isExporting = true
    renderButtons()
    refreshPageInteractivity()
    setStatus(`Preparing export for ${state.pages.length} page${state.pages.length === 1 ? "" : "s"}...`)

    try {
      const outputDocument = await window.PDFLib.PDFDocument.create()
      const sourceCache = new Map()

      for (let index = 0; index < state.pages.length; index += 1) {
        const page = state.pages[index]

        if (index === 0 || (index + 1) % 10 === 0 || index === state.pages.length - 1) {
          setStatus(`Exporting page ${index + 1} of ${state.pages.length}...`)
        }

        let sourceDocument = sourceCache.get(page.sourceId)
        if (!sourceDocument) {
          const source = state.sources.get(page.sourceId)
          if (!source) {
            continue
          }

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
      setStatus("Combined PDF downloaded")
    } catch (error) {
      console.error(error)
      pushMessage("error", "The combined PDF could not be exported.")
      setStatus("Export failed")
    } finally {
      state.isExporting = false
      renderButtons()
      refreshPageInteractivity()
    }
  }

  function clearAll() {
    stopAutoScroll()
    closePreview()

    state.pages.forEach(cleanupThumbnailForPage)
    state.pages = []
    state.messages = []
    state.dragPageId = null
    state.editingPageId = null

    queuedThumbnailIds.clear()
    thumbnailQueue.length = 0

    for (const pageId of Array.from(pageElements.keys())) {
      removePageCard(pageId)
    }
    elements.pages.replaceChildren()

    for (const sourceId of Array.from(state.sources.keys())) {
      cleanupSource(sourceId)
    }

    renderSummary()
    renderMessages()
    renderButtons()
    renderEmptyState()
    setStatus("Ready for import")
  }

  function renderSummary() {
    const fileCount = state.sources.size
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

  function renderButtons() {
    const canEdit = state.pages.length > 0 && !isBusy()
    elements.exportButton.disabled = !canEdit
    elements.clearButton.disabled = state.pages.length === 0 && state.messages.length === 0
    elements.clearButton.disabled = elements.clearButton.disabled || isBusy()
    elements.fileInput.disabled = !canImportFiles()
    elements.dropZone.classList.toggle("is-disabled", !canImportFiles())
    elements.dropZone.setAttribute("aria-disabled", String(!canImportFiles()))
  }

  function renderEmptyState() {
    const hasPages = state.pages.length > 0
    elements.emptyState.hidden = hasPages
    elements.pages.classList.toggle("is-empty", !hasPages)
  }

  function syncPageGrid() {
    renderEmptyState()

    if (state.pages.length === 0) {
      elements.pages.replaceChildren()
      return
    }

    const fragment = document.createDocumentFragment()
    for (let index = 0; index < state.pages.length; index += 1) {
      const page = state.pages[index]
      let card = pageElements.get(page.id)
      if (!card) {
        card = createPageCard(page)
      }

      updatePageCard(page, index)
      fragment.append(card)
    }

    elements.pages.replaceChildren(fragment)
    focusOrderEditorIfNeeded()
  }

  function refreshPageCards() {
    for (let index = 0; index < state.pages.length; index += 1) {
      updatePageCard(state.pages[index], index)
    }

    focusOrderEditorIfNeeded()
  }

  function createPageCard(page) {
    const card = document.createElement("article")
    card.className = "page-card"
    card.draggable = true
    card.dataset.pageId = String(page.id)

    const header = document.createElement("div")
    header.className = "page-card-header"

    const orderSlot = document.createElement("div")
    orderSlot.className = "page-order-slot"

    const deleteButton = document.createElement("button")
    deleteButton.type = "button"
    deleteButton.className = "button delete-button"
    deleteButton.dataset.action = "delete-page"
    deleteButton.dataset.preventCardDrag = "true"
    deleteButton.textContent = "Delete"

    header.append(orderSlot, deleteButton)

    const previewButton = document.createElement("button")
    previewButton.type = "button"
    previewButton.className = "page-preview"
    previewButton.dataset.action = "open-preview"
    previewButton.dataset.preventCardDrag = "true"

    const previewContent = document.createElement("div")
    previewContent.className = "page-preview-content"
    previewButton.append(previewContent)

    const meta = document.createElement("div")
    meta.className = "page-meta"

    const title = document.createElement("p")
    title.className = "page-title"
    title.textContent = page.sourceName

    const source = document.createElement("p")
    source.className = "page-source"
    source.textContent = `Original page ${page.sourcePageNumber}`

    meta.append(title, source)
    card.append(header, previewButton, meta)

    pageElements.set(page.id, card)
    pageRefs.set(page.id, {
      orderSlot,
      deleteButton,
      previewButton,
      previewContent,
      title,
      source,
    })

    if (thumbnailObserver) {
      thumbnailObserver.observe(previewButton)
    }

    return card
  }

  function updatePageCard(page, index) {
    const card = pageElements.get(page.id)
    const refs = pageRefs.get(page.id)
    if (!card || !refs) {
      return
    }

    card.classList.toggle("dragging", state.dragPageId === page.id)
    card.draggable = !isBusy()

    renderPageOrderControl(page, index, refs.orderSlot)

    refs.deleteButton.disabled = isBusy()
    refs.deleteButton.setAttribute("aria-label", `Delete page ${page.sourcePageNumber} from ${page.sourceName}`)
    refs.previewButton.disabled = isBusy()
    refs.previewButton.setAttribute("aria-label", `Open a larger preview for ${page.sourceName}, page ${page.sourcePageNumber}`)

    renderPagePreview(page, refs.previewButton, refs.previewContent)
  }

  function renderPageOrderControl(page, index, orderSlot) {
    const isEditing = state.editingPageId === page.id
    const currentControl = orderSlot.firstElementChild

    if (isEditing) {
      if (!(currentControl instanceof HTMLInputElement)) {
        const input = document.createElement("input")
        input.type = "number"
        input.className = "page-order page-order-input"
        input.dataset.action = "commit-order"
        input.dataset.pageId = String(page.id)
        input.dataset.preventCardDrag = "true"
        input.inputMode = "numeric"
        orderSlot.replaceChildren(input)
      }

      const input = orderSlot.firstElementChild
      input.min = "1"
      input.max = String(state.pages.length)
      input.value = String(index + 1)
      input.setAttribute("aria-label", `Enter a new position for ${page.sourceName}`)
      input.disabled = isBusy()
      return
    }

    if (!(currentControl instanceof HTMLButtonElement)) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "page-order page-order-button"
      button.dataset.action = "edit-order"
      button.dataset.preventCardDrag = "true"
      orderSlot.replaceChildren(button)
    }

    const button = orderSlot.firstElementChild
    button.textContent = String(index + 1)
    button.disabled = isBusy()
    button.title = "Click to move this page by number"
    button.setAttribute("aria-label", `Edit the position for ${page.sourceName}`)
  }

  function renderPagePreview(page, previewButton, previewContent) {
    previewButton.classList.toggle("is-ready", page.thumbnailStatus === "ready")
    previewButton.classList.toggle("is-loading", page.thumbnailStatus === "loading" || page.thumbnailStatus === "queued")
    previewButton.classList.toggle("is-error", page.thumbnailStatus === "error")

    if (page.thumbnailStatus === "ready" && page.thumbnailUrl) {
      const existingImage = previewContent.querySelector("img")
      if (existingImage && existingImage.src === page.thumbnailUrl) {
        return
      }

      const image = document.createElement("img")
      image.src = page.thumbnailUrl
      image.alt = `${page.sourceName}, page ${page.sourcePageNumber}`
      previewContent.replaceChildren(image)
      return
    }

    const placeholder = document.createElement("div")
    placeholder.className = "page-preview-placeholder"

    const label = document.createElement("p")
    label.className = "page-preview-status"
    if (page.thumbnailStatus === "error") {
      label.textContent = "Preview unavailable"
    } else if (page.thumbnailStatus === "loading") {
      label.textContent = "Rendering preview..."
    } else {
      label.textContent = "No preview available yet"
    }

    placeholder.append(label)
    previewContent.replaceChildren(placeholder)
  }

  function focusOrderEditorIfNeeded() {
    if (state.editingPageId == null) {
      return
    }

    requestAnimationFrame(() => {
      const activeEditor = elements.pages.querySelector("[data-action='commit-order']")
      if (!activeEditor) {
        return
      }

      activeEditor.focus()
      activeEditor.select()
    })
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
    refreshPageCards()
  }

  function beginOrderEdit(pageId) {
    if (!Number.isFinite(pageId)) {
      return
    }

    state.editingPageId = pageId
    refreshPageCards()
  }

  function cancelOrderEdit() {
    if (state.editingPageId == null) {
      return
    }

    state.editingPageId = null
    setStatus("Page move canceled")
    refreshPageCards()
  }

  function commitOrderEdit(pageId, rawValue) {
    if (state.editingPageId !== pageId) {
      return
    }

    state.editingPageId = null
    movePageToPosition(pageId, rawValue)
  }

  async function openPreview(pageId) {
    const page = getPageById(pageId)
    if (!page) {
      return
    }

    const source = state.sources.get(page.sourceId)
    if (!source) {
      return
    }

    state.previewPageId = pageId
    state.previewRenderToken += 1
    const renderToken = state.previewRenderToken

    elements.previewModal.hidden = false
    elements.previewKicker.textContent = page.sourceName
    elements.previewTitle.textContent = `Page ${page.sourcePageNumber} preview`
    renderPreviewStatus("Rendering larger preview...")
    document.body.style.overflow = "hidden"

    try {
      const pdfjsDocument = await getSourcePdfJsDocument(source)
      if (renderToken !== state.previewRenderToken) {
        return
      }

      const previewPage = await pdfjsDocument.getPage(page.sourcePageNumber)
      const baseViewport = previewPage.getViewport({ scale: 1 })
      const stageWidth = Math.max(Math.min(elements.previewStage.clientWidth - 40, 1000), 320)
      const scale = stageWidth / baseViewport.width
      const viewport = previewPage.getViewport({ scale })
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)

      await previewPage.render({
        canvasContext: context,
        viewport,
      }).promise

      if (renderToken !== state.previewRenderToken) {
        return
      }

      elements.previewStage.replaceChildren(canvas)
    } catch (error) {
      console.error(error)
      renderPreviewStatus("This preview could not be rendered.")
    }
  }

  function closePreview() {
    state.previewPageId = null
    state.previewRenderToken += 1
    elements.previewModal.hidden = true
    elements.previewKicker.textContent = "Preview"
    elements.previewTitle.textContent = "PDF page preview"
    elements.previewStage.replaceChildren()
    document.body.style.overflow = ""
  }

  function handleThumbnailIntersection(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue
      }

      const pageId = Number(entry.target.closest("[data-page-id]")?.dataset.pageId)
      queueThumbnailRender(pageId)
    }
  }

  function queueThumbnailRender(pageId) {
    const page = getPageById(pageId)
    if (!page || page.thumbnailStatus === "ready" || page.thumbnailStatus === "loading" || queuedThumbnailIds.has(pageId)) {
      return
    }

    page.thumbnailStatus = "queued"
    queuedThumbnailIds.add(pageId)
    thumbnailQueue.push(pageId)
    updateSinglePageCard(pageId)
    processThumbnailQueue()
  }

  function processThumbnailQueue() {
    while (activeThumbnailJobs < THUMBNAIL_CONCURRENCY && thumbnailQueue.length > 0) {
      const nextPageId = thumbnailQueue.shift()
      queuedThumbnailIds.delete(nextPageId)
      activeThumbnailJobs += 1
      renderThumbnailForPage(nextPageId).finally(() => {
        activeThumbnailJobs -= 1
        processThumbnailQueue()
      })
    }
  }

  async function renderThumbnailForPage(pageId) {
    const page = getPageById(pageId)
    if (!page) {
      return
    }

    page.thumbnailStatus = "loading"
    updateSinglePageCard(pageId)

    const source = state.sources.get(page.sourceId)
    if (!source) {
      return
    }

    try {
      const pdfjsDocument = await getSourcePdfJsDocument(source)
      const pdfPage = await pdfjsDocument.getPage(page.sourcePageNumber)
      const baseViewport = pdfPage.getViewport({ scale: 1 })
      const scale = THUMBNAIL_WIDTH / baseViewport.width
      const viewport = pdfPage.getViewport({ scale })
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)

      await pdfPage.render({
        canvasContext: context,
        viewport,
      }).promise

      const blob = await canvasToBlob(canvas)
      const freshPage = getPageById(pageId)
      if (!freshPage || !blob) {
        return
      }

      cleanupThumbnailForPage(freshPage)
      freshPage.thumbnailUrl = URL.createObjectURL(blob)
      freshPage.thumbnailStatus = "ready"
      updateSinglePageCard(pageId)
    } catch (error) {
      console.error(error)
      const freshPage = getPageById(pageId)
      if (!freshPage) {
        return
      }

      freshPage.thumbnailStatus = "error"
      updateSinglePageCard(pageId)
    }
  }

  async function getSourcePdfJsDocument(source) {
    if (source.pdfjsDocument) {
      return source.pdfjsDocument
    }

    if (!source.pdfjsDocumentPromise) {
      source.pdfjsDocumentPromise = window.pdfjsLib.getDocument({
        data: source.bytes.slice(),
      }).promise.then((document) => {
        source.pdfjsDocument = document
        return document
      }).catch((error) => {
        source.pdfjsDocumentPromise = null
        throw error
      })
    }

    return source.pdfjsDocumentPromise
  }

  function cleanupSource(sourceId) {
    const source = state.sources.get(sourceId)
    if (!source) {
      return
    }

    state.sources.delete(sourceId)

    if (source.pdfjsDocument && typeof source.pdfjsDocument.destroy === "function") {
      source.pdfjsDocument.destroy()
      return
    }

    if (source.pdfjsDocumentPromise) {
      source.pdfjsDocumentPromise.then((document) => {
        if (typeof document.destroy === "function") {
          document.destroy()
        }
      }).catch(() => {})
    }
  }

  function cleanupThumbnailForPage(page) {
    if (page.thumbnailUrl) {
      URL.revokeObjectURL(page.thumbnailUrl)
      page.thumbnailUrl = null
    }
  }

  function removePageCard(pageId) {
    const card = pageElements.get(pageId)
    const refs = pageRefs.get(pageId)

    if (thumbnailObserver && refs?.previewButton) {
      thumbnailObserver.unobserve(refs.previewButton)
    }

    if (card) {
      card.remove()
    }

    pageElements.delete(pageId)
    pageRefs.delete(pageId)
    queuedThumbnailIds.delete(pageId)
  }

  function updateSinglePageCard(pageId) {
    const page = getPageById(pageId)
    if (!page) {
      return
    }

    const index = state.pages.findIndex((item) => item.id === pageId)
    if (index === -1) {
      return
    }

    updatePageCard(page, index)
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

  function pruneUnusedSources() {
    const activeSourceIds = new Set(state.pages.map((page) => page.sourceId))
    for (const sourceId of Array.from(state.sources.keys())) {
      if (!activeSourceIds.has(sourceId)) {
        cleanupSource(sourceId)
      }
    }
  }

  function canImportFiles() {
    return hasPdfLib && hasPdfJs && !isBusy()
  }

  function isBusy() {
    return state.isImporting || state.isExporting
  }

  function refreshPageInteractivity() {
    for (const [pageId, card] of pageElements.entries()) {
      const refs = pageRefs.get(pageId)
      card.draggable = !isBusy()
      if (!refs) {
        continue
      }

      refs.deleteButton.disabled = isBusy()
      refs.previewButton.disabled = isBusy()

      const control = refs.orderSlot.firstElementChild
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) {
        control.disabled = isBusy()
      }
    }
  }

  function getPageById(pageId) {
    return state.pages.find((page) => page.id === pageId) || null
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

  function renderPreviewStatus(text) {
    const status = document.createElement("p")
    status.className = "preview-status"
    status.textContent = text
    elements.previewStage.replaceChildren(status)
  }

  function setStatus(text) {
    state.statusText = text
    renderStatus()
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png")
    })
  }
})

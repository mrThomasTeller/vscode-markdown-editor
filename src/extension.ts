import * as vscode from 'vscode'
import * as NodePath from 'path'
const KeyVditorOptions = 'vditor.options'

function debug(...args: any[]) {
  console.log(...args)
}

function showError(msg: string) {
  vscode.window.showErrorMessage(`[markdown-editor] ${msg}`)
}

/**
 * True when a document change came from disk rather than from the webview.
 *
 * Webview edits reach the document through applyEdit and always leave it dirty, so a
 * content change that leaves the document clean can only be VS Code reloading a file
 * that another program wrote. That also means there is no pending webview edit to
 * clobber: if the webview had unsynced content, the document would still be dirty.
 *
 * The contentChanges check matters: onDidChangeTextDocument also fires for pure
 * dirty-state transitions with an empty contentChanges array, so every save (incl.
 * autosave) emits a clean-document event that must not be mistaken for a reload.
 */
function isExternalReload(e: vscode.TextDocumentChangeEvent) {
  return e.contentChanges.length > 0 && !e.document.isDirty
}

/**
 * Opens external URIs directly and resolves local links from the Markdown file.
 */
async function openMarkdownLink(markdownFileUri: vscode.Uri, href: string) {
  if (/^https?:\/\//.test(href)) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(href))
    return
  }

  let localUri: vscode.Uri | undefined

  if (/^[a-zA-Z]:[\\/]/.test(href)) {
    localUri = vscode.Uri.file(href)
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(href))
    return
  } else {
    const targetPath = NodePath.resolve(
      NodePath.dirname(markdownFileUri.fsPath),
      href
    )
    localUri = vscode.Uri.file(targetPath)
  }

  let fileStat: vscode.FileStat
  try {
    fileStat = await vscode.workspace.fs.stat(localUri)
  } catch (error) {
    return
  }

  if (fileStat.type === vscode.FileType.Directory) {
    await vscode.commands.executeCommand('revealInExplorer', localUri)
    return
  }

  await vscode.commands.executeCommand('vscode.open', localUri)
}

export function activate(context: vscode.ExtensionContext) {
  // Register the toggle command (used by context menus/shortcuts)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-editor.toggleEditor',
      (uri?: vscode.Uri, ...args) => {
        debug('command', uri, args)
        return toggleEditor(uri instanceof vscode.Uri ? uri : undefined)
      }
    )
  )

  // Register CustomTextEditorProvider (for the toggle command, "Open With" and default editor)
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        // Every file gets its own editor, and one file can be open in several (e.g. split)
        supportsMultipleEditorsPerDocument: true,
      }
    )
  )

  context.globalState.setKeysForSync([KeyVditorOptions])
}

/**
 * Id of the built-in text editor for vscode.openWith.
 */
const TextEditorViewType = 'default'

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const { input } = tab
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom
  ) {
    return input.uri
  }
}

/**
 * Editor a tab shows, as a view type for vscode.openWith.
 */
function tabViewType(tab: vscode.Tab) {
  const { input } = tab
  return input instanceof vscode.TabInputCustom
    ? input.viewType
    : TextEditorViewType
}

/**
 * Finds the tab the toggle command was called for: the active tab when no file is
 * given (shortcut, command palette), otherwise a tab of that file (explorer and tab
 * context menus), preferring the active group and the active tab.
 */
function findSourceTab(uri?: vscode.Uri): vscode.Tab | undefined {
  const { activeTabGroup, all } = vscode.window.tabGroups
  if (!uri) {
    const tab = activeTabGroup.activeTab
    return tab && tabUri(tab) ? tab : undefined
  }
  const isFileTab = (tab: vscode.Tab) =>
    tabUri(tab)?.toString() === uri.toString()
  for (const group of [activeTabGroup, ...all.filter((g) => !g.isActive)]) {
    const tab =
      group.activeTab && isFileTab(group.activeTab)
        ? group.activeTab
        : group.tabs.find(isFileTab)
    if (tab) {
      return tab
    }
  }
}

/**
 * Switches a markdown file between the text editor and the markdown editor in
 * place: the new editor takes over the tab it was called from instead of opening
 * in a new one.
 */
async function toggleEditor(uri?: vscode.Uri) {
  const tab = findSourceTab(uri)
  uri = uri || (tab && tabUri(tab)) || vscode.window.activeTextEditor?.document.uri
  if (!uri) {
    showError(`Did not open markdown file!`)
    return
  }
  const doc = await vscode.workspace.openTextDocument(uri)
  if (doc.languageId !== 'markdown') {
    showError(`Current file language is not markdown, got ${doc.languageId}`)
    return
  }
  if (doc.isUntitled) {
    showError(`Save the file first!`)
    return
  }
  const fromMarkdownEditor =
    !!tab && tabViewType(tab) === MarkdownEditorProvider.viewType
  const targetViewType = fromMarkdownEditor
    ? TextEditorViewType
    : MarkdownEditorProvider.viewType

  // Nothing to replace, e.g. a file from the explorer that isn't open yet
  if (!tab) {
    await vscode.commands.executeCommand('vscode.openWith', uri, targetViewType, {
      preview: false,
    })
    return
  }

  const viewColumn = tab.group.viewColumn
  const sourceViewType = tabViewType(tab)
  // A new tab opens right after the active one, so activate the tab being replaced
  // first to put its replacement in the same place.
  if (!tab.isActive) {
    await vscode.commands.executeCommand('vscode.openWith', uri, sourceViewType, {
      viewColumn,
      preview: false,
    })
  }
  if (fromMarkdownEditor) {
    await MarkdownEditorProvider.flush(uri)
  }
  // Closing a tab with unsaved changes asks to save them even though the new tab
  // shows the same document, and "Don't Save" there reverts the changes. Saving
  // first keeps them and skips the dialog.
  if (doc.isDirty && !(await doc.save())) {
    return
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, targetViewType, {
    viewColumn,
    preview: false,
  })
  // Look the replaced tab up again: tab objects may go stale once tabs change
  // (Cursor recreates them all, and closing a stale one throws)
  const replaced = vscode.window.tabGroups.all
    .find((g) => g.viewColumn === viewColumn)
    ?.tabs.find(
      (t) =>
        tabUri(t)?.toString() === uri!.toString() &&
        tabViewType(t) === sourceViewType
    )
  if (replaced) {
    await vscode.window.tabGroups.close(replaced, true)
  }
}

/**
 * MarkdownEditorProvider implements CustomTextEditorProvider interface
 * Supports opening markdown files via "Open With"
 */
class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'markdown-editor.customEditor'

  /**
   * Remembers the last scroll position for each file, keyed by fsPath, so that
   * switching to another file and back doesn't reset the reading position.
   * Shared by all editors of the file, since none of them keeps its webview alive
   * across a full close (toggling to the text editor and back included).
   */
  static _scrollPositions = new Map<string, number>()

  /**
   * Open editors, so the toggle command can reach the webview of the tab it replaces.
   */
  private static _editors = new Map<
    vscode.WebviewPanel,
    { uri: vscode.Uri; flush: () => Promise<void> }
  >()

  /**
   * Makes the active editor of a file push input it hasn't synced yet into the
   * document. The webview holds an edit back until typing pauses for 100ms, and an
   * edit arriving after the editor lost focus is ignored (see 'edit'), so replacing
   * the editor right after a keystroke would lose it.
   */
  static async flush(uri: vscode.Uri) {
    for (const [panel, editor] of MarkdownEditorProvider._editors) {
      if (panel.active && editor.uri.toString() === uri.toString()) {
        await editor.flush()
      }
    }
  }

  /**
   * Hides #app until BOTH of these are true: (a) the external main.css has actually
   * finished loading (its <link>'s onload sets data-vmd-css-loaded="1" - see below),
   * and (b) main.ts confirms Vditor has fully finished building its UI and applying
   * the saved scroll position (sets data-vmd-ready="1" - see main.ts). Both
   * conditions are necessary: a script's execution is not guaranteed to wait for an
   * earlier stylesheet to finish loading, so Vditor can finish building (and fire
   * its ready signal) *before* its own real CSS sizing has actually loaded, which
   * would flash an intermediate, oddly-scaled paint (e.g. toolbar buttons at native
   * SVG size) - most noticeable right after a file switch recreates the webview.
   * This rule is deliberately inlined into the HTML <head> of the webview template
   * rather than placed in main.css itself, since that stylesheet is exactly the
   * thing this rule needs to not depend on to take effect.
   */
  static appVisibilityCss = `#app{opacity:0}body[data-vmd-ready="1"][data-vmd-css-loaded="1"] #app{opacity:1}`

  static get config() {
    return vscode.workspace.getConfiguration('markdown-editor')
  }

  /**
   * Builds initial Vditor options from VS Code settings and saved options.
   */
  static getVditorOptions(context: vscode.ExtensionContext): any {
    return {
      useVscodeThemeColor: MarkdownEditorProvider.config.get<boolean>(
        'useVscodeThemeColor'
      ),
      showLineNumbers: MarkdownEditorProvider.config.get<boolean>(
        'showLineNumbers'
      ),
      outline: {
        enable: MarkdownEditorProvider.config.get<boolean>(
          'defaultOpenOutline'
        ) === true,
      },
      ...context.globalState.get(KeyVditorOptions),
    }
  }

  static lineNumberScript = `<style>
.vditor-ir .vditor-reset{padding-left:60px!important}
.vditor-toolbar.vditor-toolbar--pin{padding-left:60px!important}
#ln-gutter{position:fixed;width:32px;pointer-events:none;user-select:none;z-index:10;overflow:hidden;border-right:1px solid rgba(128,128,128,0.12)}
#ln-gutter .ln{position:absolute;width:26px;text-align:right;font-size:11px;font-family:'Cascadia Code','Consolas',monospace;color:rgba(150,150,150,0.5);line-height:1}
</style>
<script>
(function(){
  window.__lnEnabled=true;
  var listening=false;
  function addToggle(){
    if(document.getElementById('ln-toggle'))return;
    var tb=document.querySelector('.vditor-toolbar');
    if(!tb)return;
    var btn=document.createElement('button');
    btn.id='ln-toggle';
    btn.type='button';
    btn.className='vditor-tooltipped vditor-tooltipped__s';
    btn.setAttribute('aria-label','Toggle line numbers');
    btn.style.cssText='background:none;border:none;cursor:pointer;padding:4px 3px;color:inherit;font:11px monospace;opacity:0.7;margin-left:2px';
    btn.textContent='#';
    btn.onclick=function(){
      window.__lnEnabled=!window.__lnEnabled;
      btn.style.opacity=window.__lnEnabled?'0.7':'0.3';
      var g=document.getElementById('ln-gutter');
      if(g)g.style.display=window.__lnEnabled?'':'none';
      var r=document.querySelector('.vditor-ir .vditor-reset');
      if(r)r.style.setProperty('padding-left',window.__lnEnabled?'60px':'35px','important');
      if(tb)tb.style.setProperty('padding-left',window.__lnEnabled?'60px':'35px','important');
    };
    tb.appendChild(btn);
  }
  function sync(){
    addToggle();
    if(!window.__lnEnabled)return;
    var reset=document.querySelector('.vditor-ir .vditor-reset');
    var ir=document.querySelector('.vditor-ir');
    if(!reset||!ir||reset.children.length===0) return;
    var g=document.getElementById('ln-gutter');
    if(!g){g=document.createElement('div');g.id='ln-gutter';document.body.appendChild(g)}
    var irRect=ir.getBoundingClientRect();
    g.style.left=irRect.left+'px';
    g.style.top=irRect.top+'px';
    g.style.height=irRect.height+'px';
    var kids=[];
    for(var j=0;j<reset.children.length;j++){
      var c=reset.children[j];
      if(c.offsetHeight>0&&c.id!=='fix-table-ir-wrapper') kids.push(c);
    }
    var srcLines=[];
    try{
      // Always read the live editor value instead of a snapshot received once at
      // startup: a stale snapshot drifts out of sync with the rendered blocks as
      // soon as the document is edited, producing wrong line numbers.
      var src=(window.vditor&&window.vditor.getValue)?(window.vditor.getValue()||''):'';
      var NL=String.fromCharCode(10);
      var L=src.split(NL);
      var starts=[];
      var i=0;var fence=String.fromCharCode(96,96,96);
      if(L.length>0&&L[0].trim()==='---'){
        starts.push(1);i=1;
        while(i<L.length&&L[i].trim()!=='---')i++;
        if(i<L.length)i++;
      }
      while(i<L.length){
        if(L[i].trim()===''){i++;continue}
        starts.push(i+1);
        var tr=L[i].trim();
        var rH=/^#{1,6} /;var rHR=/^(---|[*]{3}|___)$/;var rLI=/^[-*+] /;var rOL=/^[0-9]+[.)] /;var rIND=/^ +[^ ]/;
        function isBlock(s){return rH.test(s)||rLI.test(s)||rOL.test(s)||s.indexOf(fence)===0||s.charAt(0)==='|'||s.charAt(0)==='>'||rHR.test(s)}
        if(rH.test(tr)||rHR.test(tr)){i++}
        else if(tr.indexOf(fence)===0){
          i++;while(i<L.length&&L[i].trim().indexOf(fence)!==0)i++;
          if(i<L.length)i++;
        }else if(tr.charAt(0)==='|'){
          while(i<L.length&&L[i].trim().charAt(0)==='|')i++;
        }else if(tr.charAt(0)==='>'){
          while(i<L.length&&L[i].trim()!==''&&L[i].trimStart().charAt(0)==='>')i++;
        }else if(rLI.test(tr)||rOL.test(tr)){
          while(i<L.length){
            if(L[i].trim()===''){
              var nx=i+1;while(nx<L.length&&L[nx].trim()==='')nx++;
              if(nx<L.length&&(rLI.test(L[nx].trim())||rOL.test(L[nx].trim())||rIND.test(L[nx]))){i=nx}else break;
            }else{i++}
          }
        }else{
          i++;while(i<L.length&&L[i].trim()!==''){if(isBlock(L[i].trim()))break;i++}
        }
      }
      for(var j=0;j<kids.length;j++) srcLines.push(j<starts.length?starts[j]:j+1);
    }catch(e){for(var j=0;j<kids.length;j++) srcLines.push(j+1)}
    var html='';
    for(var j=0;j<kids.length;j++){
      var el=kids[j];
      var rect=el.getBoundingClientRect();
      var t=rect.top-irRect.top;
      if(t+rect.height<0||t>irRect.height) continue;
      var style=window.getComputedStyle(el);
      var fs=parseFloat(style.fontSize)||16;
      var lh=parseFloat(style.lineHeight);
      if(isNaN(lh)) lh=fs*1.6;
      var numTop=t+(lh/2)-5;
      html+='<div class="ln" style="top:'+numTop+'px">'+srcLines[j]+'</div>';
    }
    g.innerHTML=html;
    if(!listening){
      listening=true;
      ir.addEventListener('scroll',sync);
      document.addEventListener('scroll',sync,true);
      new MutationObserver(function(){requestAnimationFrame(sync)}).observe(reset,{childList:true,subtree:true,characterData:true});
    }
  }
  setInterval(sync,500);
})();
</script>`

  static getAssetsFolder(uri: vscode.Uri) {
    const imageSaveFolder = (
      MarkdownEditorProvider.config.get<string>('imageSaveFolder') || 'assets'
    )
      .replace(
        '${projectRoot}',
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || ''
      )
      .replace('${file}', uri.fsPath)
      .replace(
        '${fileBasenameNoExtension}',
        NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath))
      )
      .replace('${dir}', NodePath.dirname(uri.fsPath))
    const assetsFolder = NodePath.resolve(
      NodePath.dirname(uri.fsPath),
      imageSaveFolder
    )
    return assetsFolder
  }


  constructor(private readonly context: vscode.ExtensionContext) { }

  /**
   * Called when the markdown editor opens a file: the toggle command, "Open With" or
   * the default editor
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Set webview options
    webviewPanel.webview.options = this.getWebviewOptions()

    // Init webview content
    const uri = document.uri
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, uri)
    webviewPanel.title = NodePath.basename(uri.fsPath)

    const disposables: vscode.Disposable[] = []
    let isEditing = false
    let lastSync = Promise.resolve()
    let onFlushed: (() => void) | undefined

    MarkdownEditorProvider._editors.set(webviewPanel, {
      uri,
      flush: () =>
        new Promise<void>((resolve) => {
          onFlushed = resolve
          webviewPanel.webview.postMessage({ command: 'flush' })
          // Don't hang on a webview that never answers, e.g. one still loading
          setTimeout(resolve, 1000)
        }),
    })

    // Update title to show edit status
    const updateEditTitle = () => {
      const isDirty = document.isDirty
      if (isDirty !== isEditing) {
        isEditing = isDirty
        webviewPanel.title = `${isDirty ? '[edit]' : ''}${NodePath.basename(uri.fsPath)}`
      }
    }

    // Send update to webview
    const updateWebview = (props: { type?: 'init' | 'update'; options?: any; theme?: 'dark' | 'light' } = {}) => {
      webviewPanel.webview.postMessage({
        command: 'update',
        content: document.getText(),
        ...(props.type === 'init'
          ? { scrollTop: MarkdownEditorProvider._scrollPositions.get(uri.fsPath) || 0 }
          : {}),
        ...props,
      })
    }

    // Listen for document close
    vscode.workspace.onDidCloseTextDocument((e) => {
      if (e.fileName === uri.fsPath) {
        webviewPanel.dispose()
      }
    }, null, disposables)

    // re-init webview when VS Code theme changes
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      updateWebview({
        type: 'init',
        options: MarkdownEditorProvider.getVditorOptions(this.context),
        theme: theme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
      })
    }, null, disposables)

    // Listen for document changes (sync from external editor to webview)
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== document.fileName) {
        return
      }
      // Don't echo the webview's own edits back at it, but always take a change that
      // came from disk - see isExternalReload.
      if (webviewPanel.active && !isExternalReload(e)) {
        return
      }
      updateWebview()
      updateEditTitle()
    }, null, disposables)

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      debug('msg from webview', message, webviewPanel.active)

      const syncToEditor = async () => {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          document.uri,
          new vscode.Range(0, 0, document.lineCount, 0),
          message.content
        )
        await vscode.workspace.applyEdit(edit)
      }

      switch (message.command) {
        case 'ready':
          updateWebview({
            type: 'init',
            options: MarkdownEditorProvider.getVditorOptions(this.context),
            theme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
          })
          break
        case 'save-options':
          this.context.globalState.update(KeyVditorOptions, message.options)
          break
        case 'scroll':
          MarkdownEditorProvider._scrollPositions.set(uri.fsPath, message.top || 0)
          break
        case 'info':
          vscode.window.showInformationMessage(message.content)
          break
        case 'error':
          showError(message.content)
          break
        case 'edit':
          if (webviewPanel.active) {
            lastSync = syncToEditor()
            await lastSync
            updateEditTitle()
          }
          break
        case 'flushed':
          // content is only set when the webview had an edit it hadn't sent yet
          if (message.content !== undefined) {
            lastSync = syncToEditor()
          }
          await lastSync
          updateEditTitle()
          onFlushed?.()
          break
        case 'reset-config':
          await this.context.globalState.update(KeyVditorOptions, {})
          break
        case 'save':
          await syncToEditor()
          await document.save()
          updateEditTitle()
          break
        case 'upload': {
          const assetsFolder = MarkdownEditorProvider.getAssetsFolder(uri)
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetsFolder))
          } catch (error) {
            console.error(error)
            showError(`Invalid image folder: ${assetsFolder}`)
          }
          await Promise.all(
            message.files.map(async (f: any) => {
              const content = Buffer.from(f.base64, 'base64')
              return vscode.workspace.fs.writeFile(
                vscode.Uri.file(NodePath.join(assetsFolder, f.name)),
                content
              )
            })
          )
          const files = message.files.map((f: any) =>
            NodePath.relative(NodePath.dirname(uri.fsPath), NodePath.join(assetsFolder, f.name)).replace(/\\/g, '/')
          )
          webviewPanel.webview.postMessage({
            command: 'uploaded',
            files,
          })
          break
        }
        case 'open-link': {
          await openMarkdownLink(uri, message.href)
          break
        }
      }
    }, null, disposables)

    // Clean up resources
    webviewPanel.onDidDispose(() => {
      MarkdownEditorProvider._editors.delete(webviewPanel)
      disposables.forEach((d) => d.dispose())
    })
  }

  private static getFolders(): vscode.Uri[] {
    const data = []
    for (let i = 65; i <= 90; i++) {
      data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`))
    }
    return data
  }

  private getWebviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file('/'), ...MarkdownEditorProvider.getFolders()],
      retainContextWhenHidden: true,
      enableFindWidget: true,
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, uri: vscode.Uri): string {
    const toUri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, f))
    const baseHref = NodePath.dirname(webview.asWebviewUri(vscode.Uri.file(uri.fsPath)).toString()) + '/'
    const toMediaPath = (f: string) => `media/dist/${f}`
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri)
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri)

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />

				<style>${MarkdownEditorProvider.appVisibilityCss}</style>

				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet" onload="document.body.setAttribute('data-vmd-css-loaded','1')" onerror="document.body.setAttribute('data-vmd-css-loaded','1')">`).join('\n')}

				<title>markdown editor</title>
        <style>` +
      MarkdownEditorProvider.config.get<string>('customCss') +
      `</style>
			</head>
			<body>
				<div id="app"></div>


				${JsFiles.map((f) => `<script src="${f}"></script>`).join('\n')}
				${MarkdownEditorProvider.config.get<boolean>('showLineNumbers') !== false ? MarkdownEditorProvider.lineNumberScript : ''}
			</body>
			</html>`
    )
  }
}

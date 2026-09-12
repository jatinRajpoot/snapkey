'use strict';

const { Menu, shell, app } = require('electron');

function build({ onCapture, onOpenSettings, onOpenAbout, onOpenImage, onCheckUpdates }) {
  const template = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Capture area',
          accelerator: 'CommandOrControl+Shift+S',
          click: () => onCapture('region'),
        },
        { label: 'Capture screen', accelerator: 'CommandOrControl+Shift+F', click: () => onCapture('screen') },
        { label: 'Capture all screens', accelerator: 'CommandOrControl+Shift+A', click: () => onCapture('allScreens') },
        { type: 'separator' },
        { label: 'Quick copy', accelerator: 'CommandOrControl+Shift+D', click: () => onCapture('directCopy') },
        { type: 'separator' },
        { label: 'Annotate an image…', click: () => onOpenImage() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => onOpenSettings() },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Snapkey' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Keyboard shortcuts',
          click: () => shell.openExternal('https://github.com/'),
          visible: false,
        },
        { label: 'Check for updates…', click: () => onCheckUpdates() },
        { label: 'About Snapkey', click: () => onOpenAbout() },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { build, appName: () => app.getName() };

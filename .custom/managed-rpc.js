(function () {
    'use strict';

    // Config blocks run before RPC services cache their URL and authentication.
    angular.module('ariaNg').config(['$provide', function ($provide) {
        var rpc = window.aria2WebUiRpc;
        delete window.aria2WebUiRpc;
        if (!rpc || !rpc.secret || rpc.rpcHost !== '127.0.0.1') {
            throw new Error('Local aria2 configuration is unavailable. Open the WebUI through its Node service.');
        }
        $provide.decorator('ariaNgSettingService', ['$delegate', function (settings) {
            // Update only the current connection; retain theme, language and other UI preferences.
            settings.setDefaultRpcSetting(rpc, { keepCurrent: false, forceSet: true });
            return settings;
        }]);
    }]);
}());
